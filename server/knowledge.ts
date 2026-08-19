import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { KnowledgeChunk } from '../shared/types.js';
import {
  LOCAL_PDF_EXTENSIONS,
  LOCAL_TEXT_EXTENSIONS,
  LOCAL_TIMED_SOURCE_EXTENSIONS,
  validateLocalSourceIdentity
} from './local-source.js';
import { isPromptInjectionLikeText } from './transform.js';

export { isPromptInjectionLikeText } from './transform.js';

const STORE_SCHEMA_VERSION = 2 as const;
const LEGACY_STORE_SCHEMA_VERSION = 1 as const;
const VECTOR_ALGORITHM = 'tf-idf-cosine-sparse-v1' as const;
const TOKENIZER_VERSION = 1 as const;
const DEFAULT_MIN_SCORE = 0.12;
const DEFAULT_TOP_K = 5;
const MIN_PASSAGE_RELEVANCE = 0.16;

const ENGLISH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is', 'it', 'of', 'on',
  'or', 'that', 'the', 'this', 'to', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'with'
]);

const CJK_STOP_TOKENS = new Set([
  '什么', '为何', '多少', '如何', '怎么', '是否', '哪里', '哪个', '可以', '能够', '请问', '一下'
]);

export type KnowledgeDocumentInput = {
  id?: string;
  title: string;
  url: string;
  fetchedAt?: string;
  revision?: string;
  chunks: readonly KnowledgeChunk[];
};

export type StoredKnowledgeDocument = {
  id: string;
  title: string;
  url: string;
  fetchedAt: string;
  revision: string;
  chunks: KnowledgeChunk[];
};

type PersistedKnowledgeStore = {
  schemaVersion: typeof STORE_SCHEMA_VERSION;
  updatedAt: string;
  documents: StoredKnowledgeDocument[];
  index: PersistedSparseVectorIndex;
};

type PersistedSparseVector = {
  documentId: string;
  chunkId: string;
  revision: string;
  terms: Record<string, number>;
};

type PersistedSparseVectorIndex = {
  algorithm: typeof VECTOR_ALGORITHM;
  tokenizerVersion: typeof TOKENIZER_VERSION;
  chunkCount: number;
  vectors: PersistedSparseVector[];
  documentFrequencies: Record<string, number>;
};

export type KnowledgeSearchResult = {
  score: number;
  document: Omit<StoredKnowledgeDocument, 'chunks'>;
  chunk: KnowledgeChunk;
  source: KnowledgeChunk['source'] & {
    revision: string;
    titlePath: string[];
  };
};

export type KnowledgeCitation = {
  number: number;
  documentId: string;
  chunkId: string;
  title: string;
  titlePath: string[];
  url: string;
  locator: string;
  revision: string;
  quote: string;
};

export type KnowledgeChatResult = {
  question: string;
  answer: string;
  refused: boolean;
  citations: KnowledgeCitation[];
  warnings: string[];
};

export type LocalKnowledgeBaseOptions = {
  filePath: string;
  minScore?: number;
};

export type SearchOptions = {
  topK?: number;
  minScore?: number;
};

export type ChatOptions = SearchOptions & {
  maxCitations?: number;
};

const emptyStore = (): PersistedKnowledgeStore => ({
  schemaVersion: STORE_SCHEMA_VERSION,
  updatedAt: new Date(0).toISOString(),
  documents: [],
  index: {
    algorithm: VECTOR_ALGORITHM,
    tokenizerVersion: TOKENIZER_VERSION,
    chunkCount: 0,
    vectors: [],
    documentFrequencies: {}
  }
});

const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/gu, ' ').trim();
}

/**
 * Deterministic, dependency-free tokenization. CJK bigrams make unspaced Chinese
 * queries searchable while ordinary word tokens cover Latin-script documents.
 */
export function tokenizeForSearch(value: string): string[] {
  const normalized = normalizeText(value);
  const tokens: string[] = [];
  const cjkPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

  for (const match of normalized.matchAll(cjkPattern)) {
    const characters = Array.from(match[0]);
    if (characters.length === 1) tokens.push(characters[0]);
    for (let index = 0; index < characters.length - 1; index += 1) {
      const bigram = characters.slice(index, index + 2).join('');
      if (!CJK_STOP_TOKENS.has(bigram)) tokens.push(bigram);
    }
    if (characters.length >= 3 && characters.length <= 8) tokens.push(characters.join(''));
  }

  const withoutCjk = normalized.replace(cjkPattern, ' ');
  for (const match of withoutCjk.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (!ENGLISH_STOP_WORDS.has(match[0])) tokens.push(match[0]);
  }
  return tokens;
}

function countTokens(value: string, titlePath: readonly string[] = []): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (token: string, weight: number) => counts.set(token, (counts.get(token) ?? 0) + weight);
  tokenizeForSearch(value).forEach((token) => add(token, 1));
  titlePath.flatMap(tokenizeForSearch).forEach((token) => add(token, 2));
  return counts;
}

function toSortedRecord(values: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries([...values.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function termsToMap(terms: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(terms));
}

function vectorKey(documentId: string, chunkId: string): string {
  return JSON.stringify([documentId, chunkId]);
}

function buildSparseIndex(documents: readonly StoredKnowledgeDocument[]): PersistedSparseVectorIndex {
  const vectors: PersistedSparseVector[] = [];
  const documentFrequencies = new Map<string, number>();

  for (const document of documents) {
    for (const chunk of document.chunks) {
      const counts = countTokens(chunk.markdown, chunk.titlePath);
      counts.forEach((_count, term) => {
        documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1);
      });
      vectors.push({
        documentId: document.id,
        chunkId: chunk.id,
        revision: chunk.revision,
        terms: toSortedRecord(counts)
      });
    }
  }

  return {
    algorithm: VECTOR_ALGORITHM,
    tokenizerVersion: TOKENIZER_VERSION,
    chunkCount: vectors.length,
    vectors,
    documentFrequencies: toSortedRecord(documentFrequencies)
  };
}

function weightedCosine(
  query: Map<string, number>,
  document: Map<string, number>,
  documentFrequency: Map<string, number>,
  documentCount: number
): number {
  let dot = 0;
  let queryNorm = 0;
  let documentNorm = 0;
  const terms = new Set([...query.keys(), ...document.keys()]);

  for (const term of terms) {
    const idf = Math.log((documentCount + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1;
    const queryWeight = query.has(term) ? (1 + Math.log(query.get(term)!)) * idf : 0;
    const documentWeight = document.has(term) ? (1 + Math.log(document.get(term)!)) * idf : 0;
    dot += queryWeight * documentWeight;
    queryNorm += queryWeight ** 2;
    documentNorm += documentWeight ** 2;
  }

  return queryNorm && documentNorm ? dot / Math.sqrt(queryNorm * documentNorm) : 0;
}

function compactComparable(value: string): string {
  return normalizeText(value).replace(/[^\p{L}\p{N}]+/gu, '');
}

type ValidatedKnowledgeSource =
  | { kind: 'remote' }
  | { kind: 'local'; fileName: string; extension: string };

function invalidSource(field: string, detail: string): never {
  throw new Error(`知识文档${field}不是受控来源：${detail}。`);
}

/**
 * Local ingestion emits file:/// plus one encoded basename as an opaque source
 * identity. It is deliberately not a filesystem path and must never be passed
 * to fs APIs. Canonical encoding prevents alternate path spellings from being
 * smuggled through validation.
 */
function validateKnowledgeSource(value: string, field: string): ValidatedKnowledgeSource {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalidSource(field, 'URL 无效');
  }

  if (url.protocol === 'http:' || url.protocol === 'https:') return { kind: 'remote' };
  if (url.protocol !== 'file:') return invalidSource(field, '只支持 HTTP/HTTPS 或安全虚拟本地来源');
  try {
    const local = validateLocalSourceIdentity(value);
    return { kind: 'local', ...local };
  } catch (error) {
    return invalidSource(field, error instanceof Error ? error.message : '虚拟本地来源无效');
  }
}

function parseTimestampLocator(value: string): number | null {
  const match = value.match(/^(\d{2,3}):([0-5]\d):([0-5]\d)\.(\d{3})$/u);
  if (!match) return null;
  return (((Number(match[1]) * 60) + Number(match[2])) * 60 + Number(match[3])) * 1_000 + Number(match[4]);
}

function validateLocalLocator(source: Extract<ValidatedKnowledgeSource, { kind: 'local' }>, locator: string): void {
  if (LOCAL_PDF_EXTENSIONS.has(source.extension)) {
    const page = locator.match(/^pdf:page=([1-9]\d*)$/u);
    if (!page || Number(page[1]) > 250) invalidSource('知识块定位', 'PDF 来源必须使用有效页码');
    return;
  }
  if (LOCAL_TEXT_EXTENSIONS.has(source.extension)) {
    const lines = locator.match(/^text:L([1-9]\d*)-L([1-9]\d*)$/u);
    const startLine = lines ? Number(lines[1]) : 0;
    const endLine = lines ? Number(lines[2]) : 0;
    if (
      !lines
      || !Number.isSafeInteger(startLine)
      || !Number.isSafeInteger(endLine)
      || startLine > endLine
      || endLine > 2_000_000
    ) {
      invalidSource('知识块定位', 'TXT 来源必须使用有效行号范围');
    }
    return;
  }
  if (LOCAL_TIMED_SOURCE_EXTENSIONS.has(source.extension)) {
    const timing = locator.match(/^media:t=([^-]+)-([^-]+)$/u);
    const start = timing ? parseTimestampLocator(timing[1]) : null;
    const end = timing ? parseTimestampLocator(timing[2]) : null;
    if (start === null || end === null || start >= end) {
      invalidSource('知识块定位', '转录或媒体来源必须使用有效递增时间码');
    }
    return;
  }
  invalidSource('知识块定位', '本地来源类型不受支持');
}

function validateDocument(input: KnowledgeDocumentInput): void {
  if (!input.title.trim()) throw new Error('知识文档标题不能为空。');
  const documentSource = validateKnowledgeSource(input.url, '来源 URL');
  if (!input.chunks.length) throw new Error('知识文档至少需要一个知识块。');
  const chunkIds = new Set<string>();
  for (const chunk of input.chunks) {
    if (!chunk.id || !chunk.markdown.trim() || !chunk.revision || !chunk.source?.url || !chunk.source?.locator) {
      throw new Error('每个知识块必须包含内容、revision 和完整来源定位。');
    }
    if (chunkIds.has(chunk.id)) throw new Error(`知识文档内存在重复知识块 ID：${chunk.id}。`);
    chunkIds.add(chunk.id);
    const chunkSource = validateKnowledgeSource(chunk.source.url, `知识块 ${chunk.id} 来源 URL`);
    if (documentSource.kind === 'local') {
      if (chunkSource.kind !== 'local' || chunk.source.url !== input.url) {
        throw new Error('受控本地知识文档的所有知识块必须使用同一个虚拟来源标识。');
      }
      validateLocalLocator(documentSource, chunk.source.locator);
    } else if (chunkSource.kind === 'local') {
      throw new Error('远程知识文档不得混入虚拟本地来源知识块。');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`本地知识库字段 ${field} 无效。`);
  return value;
}

function assertDocuments(value: unknown): StoredKnowledgeDocument[] {
  if (!Array.isArray(value)) throw new Error('本地知识库 documents 字段无效。');
  const documentIds = new Set<string>();

  return value.map((rawDocument, documentIndex) => {
    if (!isRecord(rawDocument)) throw new Error(`本地知识库文档 ${documentIndex} 无效。`);
    const id = requireString(rawDocument.id, `documents[${documentIndex}].id`);
    if (documentIds.has(id)) throw new Error(`本地知识库存在重复文档 ID：${id}。`);
    documentIds.add(id);
    if (!Array.isArray(rawDocument.chunks)) throw new Error(`本地知识库文档 ${id} 的 chunks 无效。`);

    const chunks = rawDocument.chunks.map((rawChunk, chunkIndex): KnowledgeChunk => {
      if (!isRecord(rawChunk) || !isRecord(rawChunk.source)) {
        throw new Error(`本地知识库文档 ${id} 的知识块 ${chunkIndex} 无效。`);
      }
      if (!Array.isArray(rawChunk.titlePath) || rawChunk.titlePath.some((item) => typeof item !== 'string')) {
        throw new Error(`本地知识库文档 ${id} 的知识块 ${chunkIndex} 标题路径无效。`);
      }
      return {
        id: requireString(rawChunk.id, `documents[${documentIndex}].chunks[${chunkIndex}].id`),
        title: requireString(rawChunk.title, `documents[${documentIndex}].chunks[${chunkIndex}].title`),
        titlePath: [...rawChunk.titlePath] as string[],
        markdown: requireString(rawChunk.markdown, `documents[${documentIndex}].chunks[${chunkIndex}].markdown`),
        revision: requireString(rawChunk.revision, `documents[${documentIndex}].chunks[${chunkIndex}].revision`),
        source: {
          url: requireString(rawChunk.source.url, `documents[${documentIndex}].chunks[${chunkIndex}].source.url`),
          locator: requireString(rawChunk.source.locator, `documents[${documentIndex}].chunks[${chunkIndex}].source.locator`)
        }
      };
    });

    const document: StoredKnowledgeDocument = {
      id,
      title: requireString(rawDocument.title, `documents[${documentIndex}].title`),
      url: requireString(rawDocument.url, `documents[${documentIndex}].url`),
      fetchedAt: requireString(rawDocument.fetchedAt, `documents[${documentIndex}].fetchedAt`),
      revision: requireString(rawDocument.revision, `documents[${documentIndex}].revision`),
      chunks
    };
    validateDocument(document);
    return document;
  });
}

function assertPositiveTermRecord(value: unknown, field: string): Record<string, number> {
  if (!isRecord(value)) throw new Error(`本地知识库稀疏向量索引已损坏：${field} 无效。`);
  const output: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [term, count] of Object.entries(value)) {
    if (!term || typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) {
      throw new Error(`本地知识库稀疏向量索引已损坏：${field} 包含无效权重。`);
    }
    output[term] = count;
  }
  return output;
}

function sameTermRecord(left: Record<string, number>, right: Record<string, number>): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([term, count], index) => term === rightEntries[index]?.[0] && count === rightEntries[index]?.[1]);
}

function assertSparseIndex(value: unknown, documents: readonly StoredKnowledgeDocument[]): PersistedSparseVectorIndex {
  const invalid = (detail: string): never => {
    throw new Error(`本地知识库稀疏向量索引已损坏：${detail}。`);
  };
  if (!isRecord(value)) return invalid('index 字段无效');
  const candidate = value;
  if (candidate.algorithm !== VECTOR_ALGORITHM) invalid('向量算法不受支持');
  if (candidate.tokenizerVersion !== TOKENIZER_VERSION) invalid('分词器版本不受支持');
  if (!Number.isSafeInteger(candidate.chunkCount) || (candidate.chunkCount as number) < 0) invalid('chunkCount 无效');
  if (!Array.isArray(candidate.vectors)) return invalid('vectors 字段无效');
  const rawVectors = candidate.vectors;

  const vectors: PersistedSparseVector[] = rawVectors.map((rawVector: unknown, index: number) => {
    if (!isRecord(rawVector)) return invalid(`vectors[${index}] 无效`);
    return {
      documentId: requireString(rawVector.documentId, `index.vectors[${index}].documentId`),
      chunkId: requireString(rawVector.chunkId, `index.vectors[${index}].chunkId`),
      revision: requireString(rawVector.revision, `index.vectors[${index}].revision`),
      terms: assertPositiveTermRecord(rawVector.terms, `vectors[${index}].terms`)
    };
  });
  const documentFrequencies = assertPositiveTermRecord(candidate.documentFrequencies, 'documentFrequencies');
  const expected = buildSparseIndex(documents);
  if (candidate.chunkCount !== expected.chunkCount || vectors.length !== expected.vectors.length) {
    invalid('向量数量与知识块数量不一致');
  }

  const vectorsByKey = new Map<string, PersistedSparseVector>();
  for (const vector of vectors) {
    const key = vectorKey(vector.documentId, vector.chunkId);
    if (vectorsByKey.has(key)) invalid(`存在重复向量 ${vector.documentId}/${vector.chunkId}`);
    vectorsByKey.set(key, vector);
  }
  for (const expectedVector of expected.vectors) {
    const actual = vectorsByKey.get(vectorKey(expectedVector.documentId, expectedVector.chunkId))
      ?? invalid(`缺少向量 ${expectedVector.documentId}/${expectedVector.chunkId}`);
    if (actual.revision !== expectedVector.revision) invalid(`向量 revision 不匹配 ${expectedVector.documentId}/${expectedVector.chunkId}`);
    if (!sameTermRecord(actual.terms, expectedVector.terms)) invalid(`向量内容不匹配 ${expectedVector.documentId}/${expectedVector.chunkId}`);
  }
  if (!sameTermRecord(documentFrequencies, expected.documentFrequencies)) invalid('documentFrequencies 与向量不一致');

  return {
    algorithm: VECTOR_ALGORITHM,
    tokenizerVersion: TOKENIZER_VERSION,
    chunkCount: candidate.chunkCount as number,
    vectors,
    documentFrequencies
  };
}

function decodeStore(value: unknown): { state: PersistedKnowledgeStore; migrated: boolean } {
  if (!isRecord(value)) throw new Error('本地知识库文件不是有效 JSON 对象。');
  if (value.schemaVersion === LEGACY_STORE_SCHEMA_VERSION) {
    const documents = assertDocuments(value.documents);
    return {
      state: {
        schemaVersion: STORE_SCHEMA_VERSION,
        updatedAt: requireString(value.updatedAt, 'updatedAt'),
        documents,
        index: buildSparseIndex(documents)
      },
      migrated: true
    };
  }
  if (value.schemaVersion !== STORE_SCHEMA_VERSION) throw new Error('本地知识库版本不受支持或内容已损坏。');
  const documents = assertDocuments(value.documents);
  return {
    state: {
      schemaVersion: STORE_SCHEMA_VERSION,
      updatedAt: requireString(value.updatedAt, 'updatedAt'),
      documents,
      index: assertSparseIndex(value.index, documents)
    },
    migrated: false
  };
}

function extractCandidatePassages(markdown: string): string[] {
  return markdown
    .split(/\n{2,}|(?<=[。！？])\s*|(?<=[.!?])\s+/u)
    .map((value) => value.trim())
    .filter((value) => value.length >= 4 && value.length <= 800 && !/^#{1,6}\s+[^\n]+$/u.test(value));
}

function passageRelevance(questionTokens: Set<string>, passage: string): number {
  const passageTokens = new Set(tokenizeForSearch(passage));
  if (!questionTokens.size || !passageTokens.size) return 0;
  let overlap = 0;
  questionTokens.forEach((token) => {
    if (passageTokens.has(token)) overlap += 1;
  });
  const minimumOverlap = questionTokens.size <= 2 ? 1 : 2;
  const questionCoverage = overlap / questionTokens.size;
  if (overlap < minimumOverlap || questionCoverage < 0.4) return 0;
  return overlap / Math.sqrt(questionTokens.size * passageTokens.size);
}

export class LocalKnowledgeBase {
  readonly filePath: string;
  readonly minScore: number;
  private state: PersistedKnowledgeStore = emptyStore();
  private loaded: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: LocalKnowledgeBaseOptions) {
    if (!options.filePath?.trim()) throw new Error('必须注入本地知识库文件路径。');
    if (options.minScore !== undefined && (options.minScore < 0 || options.minScore > 1)) {
      throw new Error('minScore 必须在 0 到 1 之间。');
    }
    this.filePath = path.resolve(options.filePath);
    this.minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        try {
          const decoded = decodeStore(JSON.parse(await fs.readFile(this.filePath, 'utf8')) as unknown);
          this.state = decoded.state;
          if (decoded.migrated) await this.persist();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            this.state = emptyStore();
            return;
          }
          throw error;
        }
      })();
    }
    await this.loaded;
  }

  private async persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const serialized = `${JSON.stringify(this.state, null, 2)}\n`;
      try {
        await fs.writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporaryPath, this.filePath);
      } catch (error) {
        await fs.unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    });
    await this.writeQueue;
  }

  async upsertDocument(input: KnowledgeDocumentInput): Promise<StoredKnowledgeDocument> {
    validateDocument(input);
    await this.ensureLoaded();
    const fetchedAt = input.fetchedAt ?? new Date().toISOString();
    const id = input.id?.trim() || `document-${sha256(input.url).slice(0, 20)}`;
    const chunks = input.chunks.map((chunk) => clone(chunk));
    const revision = input.revision ?? `sha256:${sha256(chunks.map((chunk) => chunk.revision).join('\n'))}`;
    const document: StoredKnowledgeDocument = {
      id,
      title: input.title.trim(),
      url: input.url,
      fetchedAt,
      revision,
      chunks
    };
    const existing = this.state.documents.findIndex((item) => item.id === id);
    if (existing >= 0) this.state.documents[existing] = document;
    else this.state.documents.push(document);
    this.state.documents.sort((left, right) => left.id.localeCompare(right.id));
    this.state.index = buildSparseIndex(this.state.documents);
    this.state.updatedAt = fetchedAt;
    await this.persist();
    return clone(document);
  }

  async removeDocument(documentId: string): Promise<boolean> {
    await this.ensureLoaded();
    const previousLength = this.state.documents.length;
    this.state.documents = this.state.documents.filter((document) => document.id !== documentId);
    if (this.state.documents.length === previousLength) return false;
    this.state.index = buildSparseIndex(this.state.documents);
    this.state.updatedAt = new Date().toISOString();
    await this.persist();
    return true;
  }

  async listDocuments(): Promise<StoredKnowledgeDocument[]> {
    await this.ensureLoaded();
    await this.writeQueue;
    return clone(this.state.documents);
  }

  async search(query: string, options: SearchOptions = {}): Promise<KnowledgeSearchResult[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];
    await this.ensureLoaded();
    await this.writeQueue;

    const documentsById = new Map(this.state.documents.map((document) => [document.id, document]));
    const entries = this.state.index.vectors.map((vector) => {
      const document = documentsById.get(vector.documentId);
      const chunk = document?.chunks.find((item) => item.id === vector.chunkId);
      if (!document || !chunk) throw new Error('本地知识库稀疏向量索引与文档内容不一致。');
      return { document, chunk, vector: termsToMap(vector.terms) };
    });
    if (!entries.length) return [];
    const frequencies = termsToMap(this.state.index.documentFrequencies);
    const queryVector = countTokens(normalizedQuery);
    if (!queryVector.size) return [];
    const comparableQuery = compactComparable(normalizedQuery);
    const minimum = options.minScore ?? this.minScore;
    const topK = Math.max(1, Math.min(options.topK ?? DEFAULT_TOP_K, 50));

    return entries
      .map(({ document, chunk, vector }): KnowledgeSearchResult => {
        const cosine = weightedCosine(queryVector, vector, frequencies, this.state.index.chunkCount);
        const exactBonus = comparableQuery.length >= 2 && compactComparable(chunk.markdown).includes(comparableQuery) ? 0.15 : 0;
        const { chunks: _chunks, ...documentMetadata } = document;
        return {
          score: Number(Math.min(1, cosine + exactBonus).toFixed(6)),
          document: clone(documentMetadata),
          chunk: clone(chunk),
          source: {
            ...clone(chunk.source),
            revision: chunk.revision,
            titlePath: [...chunk.titlePath]
          }
        };
      })
      .filter((result) => result.score >= minimum)
      .sort((left, right) => right.score - left.score
        || left.document.id.localeCompare(right.document.id)
        || left.chunk.id.localeCompare(right.chunk.id))
      .slice(0, topK);
  }

  async chat(question: string, options: ChatOptions = {}): Promise<KnowledgeChatResult> {
    const trimmedQuestion = question.trim();
    const refusal = '在本地知识库中没有找到足够的可引用证据，因此无法回答这个问题。';
    if (!trimmedQuestion) {
      return { question: trimmedQuestion, answer: refusal, refused: true, citations: [], warnings: [] };
    }

    const searchResults = await this.search(trimmedQuestion, {
      topK: Math.max(options.topK ?? DEFAULT_TOP_K, options.maxCitations ?? 3),
      minScore: options.minScore
    });
    const questionTokens = new Set(tokenizeForSearch(trimmedQuestion));
    const maxCitations = Math.max(1, Math.min(options.maxCitations ?? 3, 8));
    const warnings: string[] = [];
    const candidates: Array<{ passage: string; relevance: number; result: KnowledgeSearchResult }> = [];

    searchResults.forEach((result) => {
      const passages = extractCandidatePassages(result.chunk.markdown);
      if (passages.some(isPromptInjectionLikeText)) {
        warnings.push(`已忽略知识块 ${result.chunk.id} 中疑似对 AI 发出的网页指令。`);
      }
      passages
        .filter((passage) => !isPromptInjectionLikeText(passage))
        .forEach((passage) => {
          const relevance = passageRelevance(questionTokens, passage);
          if (relevance >= MIN_PASSAGE_RELEVANCE) {
            candidates.push({ passage, relevance: relevance * result.score, result });
          }
        });
    });

    candidates.sort((left, right) => right.relevance - left.relevance
      || left.result.chunk.id.localeCompare(right.result.chunk.id)
      || left.passage.localeCompare(right.passage));
    const strongestCandidate = candidates[0]?.relevance ?? 0;
    const relativeRelevanceFloor = strongestCandidate * 0.35;
    const usedChunks = new Set<string>();
    const usedPassages = new Set<string>();
    const citations: KnowledgeCitation[] = [];
    for (const candidate of candidates) {
      if (candidate.relevance < relativeRelevanceFloor) continue;
      const chunkKey = `${candidate.result.document.id}:${candidate.result.chunk.id}`;
      if (usedChunks.has(chunkKey) || usedPassages.has(candidate.passage)) continue;
      usedChunks.add(chunkKey);
      usedPassages.add(candidate.passage);
      citations.push({
        number: citations.length + 1,
        documentId: candidate.result.document.id,
        chunkId: candidate.result.chunk.id,
        title: candidate.result.chunk.title,
        titlePath: [...candidate.result.chunk.titlePath],
        url: candidate.result.source.url,
        locator: candidate.result.source.locator,
        revision: candidate.result.source.revision,
        quote: candidate.passage
      });
      if (citations.length >= maxCitations) break;
    }

    if (!citations.length) {
      return {
        question: trimmedQuestion,
        answer: refusal,
        refused: true,
        citations: [],
        warnings: [...new Set(warnings)]
      };
    }

    return {
      question: trimmedQuestion,
      answer: citations.map((citation) => `- ${citation.quote} [${citation.number}]`).join('\n'),
      refused: false,
      citations,
      warnings: [...new Set(warnings)]
    };
  }
}
