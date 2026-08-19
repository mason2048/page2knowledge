import crypto from 'node:crypto';
import type {
  ContextPackage,
  KeyFact,
  KnowledgeChunk,
  KnowledgeResult,
  KnowledgeWarning
} from '../shared/types.js';
import { buildFacts, toContextPackage } from './transform.js';

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const shortHash = (value: string) => hash(value).slice(0, 16);

export type VersioningErrorCode =
  | 'INVALID_SOURCE_URL'
  | 'SAME_URL_REQUIRED'
  | 'NO_CHUNKS_AVAILABLE'
  | 'ALL_CHUNKS_EXCLUDED'
  | 'INVALID_CHUNK_TITLE'
  | 'CHUNK_NOT_FOUND';

export class VersioningError extends Error {
  readonly code: VersioningErrorCode;

  constructor(code: VersioningErrorCode, message: string) {
    super(message);
    this.name = 'VersioningError';
    this.code = code;
  }
}

export type ChunkChangeStatus = 'added' | 'removed' | 'changed' | 'unchanged';

export type LineDiffEntry = {
  kind: 'context' | 'added' | 'removed';
  text: string;
  beforeLine: number | null;
  afterLine: number | null;
};

export type ChunkVersion = {
  id: string;
  title: string;
  titlePath: string[];
  markdown: string;
  revision: string;
  source: KnowledgeChunk['source'];
};

export type ChunkVersionDiff = {
  matchKey: string;
  titlePath: string[];
  occurrence: number;
  status: ChunkChangeStatus;
  before: ChunkVersion | null;
  after: ChunkVersion | null;
  beforeRevision: string | null;
  afterRevision: string | null;
  lineDiff: LineDiffEntry[];
  readableDiff: string;
  beforeFactIds: string[];
  afterFactIds: string[];
  affectedChunkIds: string[];
  affectedFactIds: string[];
};

export type KnowledgeVersionDiff = {
  sourceUrl: string;
  beforePackageId: string;
  afterPackageId: string;
  summary: Record<ChunkChangeStatus, number>;
  blocks: ChunkVersionDiff[];
  added: ChunkVersionDiff[];
  removed: ChunkVersionDiff[];
  changed: ChunkVersionDiff[];
  unchanged: ChunkVersionDiff[];
  affectedChunkIds: string[];
  affectedFactIds: string[];
};

export type FilteredKnowledgeExport = {
  result: KnowledgeResult;
  contextPackage: ContextPackage;
  excludedChunkIds: string[];
};

export type EditedKnowledgeExport = {
  result: KnowledgeResult;
  contextPackage: ContextPackage;
  previousChunkId: string;
  chunkId: string;
};

function canonicalSourceUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString();
  } catch {
    throw new VersioningError('INVALID_SOURCE_URL', `无法比较无效的来源 URL：${value}`);
  }
}

function titlePathKey(titlePath: string[]): string {
  return JSON.stringify(titlePath);
}

function cloneChunk(chunk: KnowledgeChunk): KnowledgeChunk {
  return {
    ...chunk,
    titlePath: [...chunk.titlePath],
    source: { ...chunk.source }
  };
}

function cloneChunkVersion(chunk: KnowledgeChunk): ChunkVersion {
  return cloneChunk(chunk);
}

function cloneWarning(warning: KnowledgeWarning): KnowledgeWarning {
  return {
    ...warning,
    ...(warning.chunkIds ? { chunkIds: [...warning.chunkIds] } : {})
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function markdownLines(markdown: string): string[] {
  return markdown ? markdown.split('\n') : [];
}

function fallbackLineOperations(before: string[], after: string[]): Array<{ kind: LineDiffEntry['kind']; text: string }> {
  let prefixLength = 0;
  while (
    prefixLength < before.length
    && prefixLength < after.length
    && before[prefixLength] === after[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < before.length - prefixLength
    && suffixLength < after.length - prefixLength
    && before[before.length - 1 - suffixLength] === after[after.length - 1 - suffixLength]
  ) {
    suffixLength += 1;
  }

  return [
    ...before.slice(0, prefixLength).map((text) => ({ kind: 'context' as const, text })),
    ...before.slice(prefixLength, before.length - suffixLength).map((text) => ({ kind: 'removed' as const, text })),
    ...after.slice(prefixLength, after.length - suffixLength).map((text) => ({ kind: 'added' as const, text })),
    ...before.slice(before.length - suffixLength).map((text) => ({ kind: 'context' as const, text }))
  ];
}

function lineOperations(before: string[], after: string[]): Array<{ kind: LineDiffEntry['kind']; text: string }> {
  // Normal documentation sections are small enough for an exact LCS. The bounded
  // fallback keeps a pathological, generated mega-section from exhausting memory.
  if (before.length * after.length > 2_000_000) return fallbackLineOperations(before, after);

  const table = Array.from(
    { length: before.length + 1 },
    () => new Uint32Array(after.length + 1)
  );
  for (let beforeIndex = before.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = after.length - 1; afterIndex >= 0; afterIndex -= 1) {
      table[beforeIndex][afterIndex] = before[beforeIndex] === after[afterIndex]
        ? table[beforeIndex + 1][afterIndex + 1] + 1
        : Math.max(table[beforeIndex + 1][afterIndex], table[beforeIndex][afterIndex + 1]);
    }
  }

  const operations: Array<{ kind: LineDiffEntry['kind']; text: string }> = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < before.length || afterIndex < after.length) {
    if (
      beforeIndex < before.length
      && afterIndex < after.length
      && before[beforeIndex] === after[afterIndex]
    ) {
      operations.push({ kind: 'context', text: before[beforeIndex] });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (
      afterIndex < after.length
      && (beforeIndex >= before.length || table[beforeIndex][afterIndex + 1] >= table[beforeIndex + 1][afterIndex])
    ) {
      operations.push({ kind: 'added', text: after[afterIndex] });
      afterIndex += 1;
    } else {
      operations.push({ kind: 'removed', text: before[beforeIndex] });
      beforeIndex += 1;
    }
  }
  return operations;
}

export function createLineDiff(beforeMarkdown: string, afterMarkdown: string): LineDiffEntry[] {
  const operations = lineOperations(markdownLines(beforeMarkdown), markdownLines(afterMarkdown));
  let beforeLine = 1;
  let afterLine = 1;
  return operations.map((operation) => {
    if (operation.kind === 'context') {
      const entry = { ...operation, beforeLine, afterLine };
      beforeLine += 1;
      afterLine += 1;
      return entry;
    }
    if (operation.kind === 'removed') {
      const entry = { ...operation, beforeLine, afterLine: null };
      beforeLine += 1;
      return entry;
    }
    const entry = { ...operation, beforeLine: null, afterLine };
    afterLine += 1;
    return entry;
  });
}

export function formatLineDiff(entries: LineDiffEntry[]): string {
  return entries.map((entry) => {
    const marker = entry.kind === 'added' ? '+' : entry.kind === 'removed' ? '-' : ' ';
    const before = entry.beforeLine === null ? '   ' : String(entry.beforeLine).padStart(3, ' ');
    const after = entry.afterLine === null ? '   ' : String(entry.afterLine).padStart(3, ' ');
    return `${before} ${after} ${marker} ${entry.text}`;
  }).join('\n');
}

function factsForChunk(result: KnowledgeResult, chunkId: string | undefined): string[] {
  if (!chunkId) return [];
  return result.keyFacts.filter((fact) => fact.chunkId === chunkId).map((fact) => fact.id);
}

function makeBlockDiff(
  beforeResult: KnowledgeResult,
  afterResult: KnowledgeResult,
  beforeChunk: KnowledgeChunk | undefined,
  afterChunk: KnowledgeChunk | undefined,
  titlePath: string[],
  occurrence: number
): ChunkVersionDiff {
  const status: ChunkChangeStatus = !beforeChunk
    ? 'added'
    : !afterChunk
      ? 'removed'
      : beforeChunk.revision === afterChunk.revision
        ? 'unchanged'
        : 'changed';
  const beforeFactIds = factsForChunk(beforeResult, beforeChunk?.id);
  const afterFactIds = factsForChunk(afterResult, afterChunk?.id);
  const lineDiff = createLineDiff(beforeChunk?.markdown ?? '', afterChunk?.markdown ?? '');
  const affectedChunkIds = status === 'unchanged'
    ? []
    : unique([beforeChunk?.id, afterChunk?.id].filter((id): id is string => Boolean(id)));
  const affectedFactIds = status === 'unchanged' ? [] : unique([...beforeFactIds, ...afterFactIds]);

  return {
    matchKey: `${titlePathKey(titlePath)}#${occurrence}`,
    titlePath: [...titlePath],
    occurrence,
    status,
    before: beforeChunk ? cloneChunkVersion(beforeChunk) : null,
    after: afterChunk ? cloneChunkVersion(afterChunk) : null,
    beforeRevision: beforeChunk?.revision ?? null,
    afterRevision: afterChunk?.revision ?? null,
    lineDiff,
    readableDiff: formatLineDiff(lineDiff),
    beforeFactIds,
    afterFactIds,
    affectedChunkIds,
    affectedFactIds
  };
}

export function compareKnowledgeVersions(
  beforeResult: KnowledgeResult,
  afterResult: KnowledgeResult
): KnowledgeVersionDiff {
  const beforeUrl = canonicalSourceUrl(beforeResult.snapshot.requestedUrl);
  const afterUrl = canonicalSourceUrl(afterResult.snapshot.requestedUrl);
  if (beforeUrl !== afterUrl) {
    throw new VersioningError(
      'SAME_URL_REQUIRED',
      `只能比较同一 URL 的两个版本：${beforeUrl} 与 ${afterUrl}`
    );
  }

  const beforeByPath = new Map<string, KnowledgeChunk[]>();
  const afterByPath = new Map<string, KnowledgeChunk[]>();
  for (const chunk of beforeResult.chunks) {
    const key = titlePathKey(chunk.titlePath);
    beforeByPath.set(key, [...(beforeByPath.get(key) ?? []), chunk]);
  }
  for (const chunk of afterResult.chunks) {
    const key = titlePathKey(chunk.titlePath);
    afterByPath.set(key, [...(afterByPath.get(key) ?? []), chunk]);
  }

  // Use current-document order, then append paths that only existed before.
  const orderedPathKeys = unique([
    ...afterResult.chunks.map((chunk) => titlePathKey(chunk.titlePath)),
    ...beforeResult.chunks.map((chunk) => titlePathKey(chunk.titlePath))
  ]);
  const blocks: ChunkVersionDiff[] = [];
  for (const key of orderedPathKeys) {
    const beforeChunks = beforeByPath.get(key) ?? [];
    const afterChunks = afterByPath.get(key) ?? [];
    const titlePath = afterChunks[0]?.titlePath ?? beforeChunks[0]?.titlePath ?? ['正文'];
    const count = Math.max(beforeChunks.length, afterChunks.length);
    for (let index = 0; index < count; index += 1) {
      blocks.push(makeBlockDiff(
        beforeResult,
        afterResult,
        beforeChunks[index],
        afterChunks[index],
        titlePath,
        index + 1
      ));
    }
  }

  const added = blocks.filter((block) => block.status === 'added');
  const removed = blocks.filter((block) => block.status === 'removed');
  const changed = blocks.filter((block) => block.status === 'changed');
  const unchanged = blocks.filter((block) => block.status === 'unchanged');
  return {
    sourceUrl: beforeUrl,
    beforePackageId: beforeResult.packageId,
    afterPackageId: afterResult.packageId,
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged: unchanged.length
    },
    blocks,
    added,
    removed,
    changed,
    unchanged,
    affectedChunkIds: unique(blocks.flatMap((block) => block.affectedChunkIds)),
    affectedFactIds: unique(blocks.flatMap((block) => block.affectedFactIds))
  };
}

function proseFromChunk(chunk: KnowledgeChunk): string {
  return chunk.markdown
    .replace(/^#{1,6}\s+.*$/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .trim();
}

function buildSummary(chunks: KnowledgeChunk[], facts: KeyFact[], title: string): string {
  if (facts.length) return facts.slice(0, 2).map((fact) => fact.statement).join(' ').slice(0, 360);
  const firstProse = chunks.map(proseFromChunk).find(Boolean);
  return firstProse?.slice(0, 360) || `已提取《${title}》中保留的公开正文。`;
}

function filteredWarnings(warnings: KnowledgeWarning[], includedChunkIds: Set<string>): KnowledgeWarning[] {
  return warnings.flatMap((warning) => {
    if (!warning.chunkIds) return [cloneWarning(warning)];
    const chunkIds = warning.chunkIds.filter((chunkId) => includedChunkIds.has(chunkId));
    return chunkIds.length ? [{ ...warning, chunkIds }] : [];
  });
}

export function filterKnowledgeResult(
  original: KnowledgeResult,
  excludedChunkIds: readonly string[]
): KnowledgeResult {
  if (!original.chunks.length) {
    throw new VersioningError('NO_CHUNKS_AVAILABLE', '当前知识结果没有可导出的知识块。');
  }

  const requestedExclusions = new Set(excludedChunkIds);
  const actualExcludedIds = original.chunks
    .filter((chunk) => requestedExclusions.has(chunk.id))
    .map((chunk) => chunk.id);
  const actualExclusions = new Set(actualExcludedIds);
  const chunks = original.chunks
    .filter((chunk) => !actualExclusions.has(chunk.id))
    .map(cloneChunk);
  if (!chunks.length) {
    throw new VersioningError('ALL_CHUNKS_EXCLUDED', '不能排除全部知识块；请至少保留一个区块后再导出。');
  }

  const markdown = chunks.map((chunk) => chunk.markdown).join('\n\n');
  const keyFacts = buildFacts(chunks);
  const originalFactIds = Array.isArray(original.keyFacts)
    ? original.keyFacts.map((fact) => fact && typeof fact === 'object' && 'id' in fact ? String(fact.id) : '')
    : [];
  const factPolicyChanged = originalFactIds.length !== keyFacts.length
    || originalFactIds.some((id, index) => id !== keyFacts[index]?.id);
  const includedChunkIds = new Set(chunks.map((chunk) => chunk.id));
  return {
    schemaVersion: original.schemaVersion,
    packageId: actualExcludedIds.length || factPolicyChanged ? crypto.randomUUID() : original.packageId,
    name: original.name,
    ...(original.sourceKind ? { sourceKind: original.sourceKind } : {}),
    snapshot: {
      ...original.snapshot,
      contentHash: `sha256:${hash(markdown)}`
    },
    markdown,
    summary: buildSummary(chunks, keyFacts, original.snapshot.title),
    keyFacts,
    chunks,
    warnings: filteredWarnings(original.warnings, includedChunkIds)
  };
}

export function createFilteredKnowledgeExport(
  original: KnowledgeResult,
  excludedChunkIds: readonly string[]
): FilteredKnowledgeExport {
  const result = filterKnowledgeResult(original, excludedChunkIds);
  const existingIds = new Set(original.chunks.map((chunk) => chunk.id));
  const excluded = unique(excludedChunkIds.filter((id) => existingIds.has(id)));
  return {
    result,
    contextPackage: toContextPackage(result),
    excludedChunkIds: excluded
  };
}

function startsWithPath(value: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= value.length && prefix.every((part, index) => value[index] === part);
}

export function editKnowledgeChunkTitle(
  original: KnowledgeResult,
  chunkId: string,
  requestedTitle: string
): EditedKnowledgeExport {
  const title = requestedTitle.replace(/\s+/gu, ' ').trim();
  if (!title || title.length > 160 || /[\r\n]/u.test(requestedTitle)) {
    throw new VersioningError('INVALID_CHUNK_TITLE', '标题必须是 1 到 160 个字符的单行文本。');
  }
  const targetIndex = original.chunks.findIndex((chunk) => chunk.id === chunkId);
  if (targetIndex < 0) throw new VersioningError('CHUNK_NOT_FOUND', '找不到要编辑的知识块。');
  const target = original.chunks[targetIndex];
  const oldPath = target.titlePath;
  const nextPath = [...oldPath.slice(0, -1), title];
  const nextSiblingIndex = original.chunks.findIndex((chunk, index) => (
    index > targetIndex && chunk.titlePath.length <= oldPath.length
  ));
  const subtreeEnd = nextSiblingIndex < 0 ? original.chunks.length : nextSiblingIndex;
  const idMap = new Map<string, string>();
  const idOccurrences = new Map<string, number>();
  const chunks = original.chunks.map((chunk, index) => {
    const isTarget = index === targetIndex;
    const isInTargetSubtree = index >= targetIndex && index < subtreeEnd;
    const titlePath = isInTargetSubtree && startsWithPath(chunk.titlePath, oldPath)
      ? [...nextPath, ...chunk.titlePath.slice(oldPath.length)]
      : [...chunk.titlePath];
    const markdown = isTarget
      ? chunk.markdown.replace(/^(#{1,6})\s+[^\n]+/u, `$1 ${title}`)
      : chunk.markdown;
    const revision = `sha256:${hash(markdown)}`;
    const idSignature = `${titlePath.join('>')}\n${markdown}`;
    const occurrence = (idOccurrences.get(idSignature) ?? 0) + 1;
    idOccurrences.set(idSignature, occurrence);
    const id = `chunk-${shortHash(occurrence === 1 ? idSignature : `${idSignature}\noccurrence:${occurrence}`)}`;
    idMap.set(chunk.id, id);
    return {
      ...cloneChunk(chunk),
      id,
      title: isTarget ? title : chunk.title,
      titlePath,
      markdown,
      revision
    };
  });
  const markdown = chunks.map((chunk) => chunk.markdown).join('\n\n');
  const keyFacts = buildFacts(chunks);
  const includedChunkIds = new Set(chunks.map((chunk) => chunk.id));
  const warnings = original.warnings.flatMap((warning) => {
    if (!warning.chunkIds) return [cloneWarning(warning)];
    const chunkIds = warning.chunkIds.map((id) => idMap.get(id) ?? id).filter((id) => includedChunkIds.has(id));
    return chunkIds.length ? [{ ...warning, chunkIds }] : [];
  });
  const isRootTitle = oldPath.length === 1;
  const result: KnowledgeResult = {
    ...original,
    packageId: crypto.randomUUID(),
    snapshot: {
      ...original.snapshot,
      title: isRootTitle ? title : original.snapshot.title,
      contentHash: `sha256:${hash(markdown)}`
    },
    markdown,
    summary: buildSummary(chunks, keyFacts, isRootTitle ? title : original.snapshot.title),
    keyFacts,
    chunks,
    warnings
  };
  return {
    result,
    contextPackage: toContextPackage(result),
    previousChunkId: target.id,
    chunkId: idMap.get(target.id)!
  };
}
