import crypto from 'node:crypto';
import path from 'node:path';
import type {
  KnowledgeChunk,
  KnowledgeResult,
  KnowledgeWarning
} from '../shared/types.js';
import { buildLocalSourceIdentity, cleanLocalFileName } from './local-source.js';
import { buildFacts, isPromptInjectionLikeText } from './transform.js';

const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const shortHash = (value: string) => hash(value).slice(0, 16);

export const INGESTION_LIMITS = {
  maxPdfBytes: 20 * 1024 * 1024,
  maxTranscriptBytes: 5 * 1024 * 1024,
  maxPdfPages: 250,
  maxTranscriptCues: 20_000,
  maxTranscriptSections: 2_000,
  maxExtractedCharacters: 2_000_000
} as const;

const RAW_MEDIA_EXTENSIONS = new Set([
  '.aac', '.avi', '.flac', '.m4a', '.m4v', '.mkv', '.mov', '.mp3', '.mp4',
  '.mpeg', '.mpg', '.ogg', '.opus', '.wav', '.webm', '.wmv'
]);

const SECRET_PATTERNS = [
  /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\b(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}["']?/gi
];

export class IngestionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly suggestion: string
  ) {
    super(message);
    this.name = 'IngestionError';
  }
}

export type PdfPageText = {
  pageNumber: number;
  text: string;
};

export type PdfParseOutput = {
  pages: PdfPageText[];
  title?: string | null;
  author?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

export type PdfParser = (buffer: Buffer) => Promise<PdfParseOutput>;

export type LocalBufferInput = {
  buffer: Buffer;
  fileName: string;
  mimeType?: string;
  observedAt?: string;
};

export type PdfIngestionInput = LocalBufferInput & {
  parser?: PdfParser;
};

export type TranscriptFormat = 'vtt' | 'srt' | 'txt';

type LocatedSection = {
  title: string;
  titlePath: string[];
  markdown: string;
  locator: string;
};

type TranscriptCue = {
  start: string;
  end: string;
  text: string;
};

function cleanFileName(fileName: string): string {
  try {
    return cleanLocalFileName(fileName);
  } catch {
    throw new IngestionError('INVALID_FILE_NAME', '文件名无效。', '请提供带扩展名的本地文件名。');
  }
}

function normalizeObservedAt(value: string | undefined): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new IngestionError('INVALID_OBSERVED_AT', '导入时间格式无效。', '请使用 ISO-8601 时间，或省略该字段。');
  }
  return parsed.toISOString();
}

function ensureBuffer(buffer: Buffer, limit: number, kind: string): void {
  if (!Buffer.isBuffer(buffer)) {
    throw new IngestionError('INVALID_BUFFER', `${kind}输入必须是本地 Buffer。`, '请先在本机读取文件，再传入二进制内容。');
  }
  if (buffer.length === 0) {
    throw new IngestionError('EMPTY_FILE', `${kind}文件为空。`, '请选择包含正文的文件。');
  }
  if (buffer.length > limit) {
    throw new IngestionError(
      'FILE_TOO_LARGE',
      `${kind}文件超过 ${(limit / 1024 / 1024).toFixed(0)} MB 本地解析限制。`,
      '请拆分文件后重试；应用不会上传或继续处理该文件。'
    );
  }
}

function decodeUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '');
  } catch {
    throw new IngestionError('INVALID_TEXT_ENCODING', '转录文件不是有效的 UTF-8 文本。', '请将文件转换为 UTF-8 编码后重试。');
  }
}

function redactSecrets(value: string): { text: string; found: boolean } {
  let found = false;
  let text = value;
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      found = true;
      return '[REDACTED_SECRET]';
    });
  }
  return { text, found };
}

function escapeMarkdownHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function safeMetadata(value: string | null | undefined, fallback = ''): string {
  const normalized = String(value ?? '')
    .replace(/[\0-\x1F\x7F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return normalized || fallback;
}

function plainText(value: string): string {
  const withoutMarkup = value
    .replace(/<v(?:\.[^ >]+)?(?:\s+[^>]+)?>/gi, '')
    .replace(/<\/?(?:c(?:\.[^ >]+)?|i|b|u|ruby|rt|lang)(?:\s+[^>]+)?>/gi, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .trim();
  return escapeMarkdownHtml(withoutMarkup);
}

function createChunks(sections: LocatedSection[], sourceUrl: string): KnowledgeChunk[] {
  return sections.map((section) => {
    const revision = `sha256:${hash(section.markdown)}`;
    return {
      id: `chunk-${shortHash(`${sourceUrl}\n${section.locator}\n${section.titlePath.join('>')}\n${section.markdown}`)}`,
      title: section.title,
      titlePath: section.titlePath,
      markdown: section.markdown,
      revision,
      source: { url: sourceUrl, locator: section.locator }
    };
  });
}

function createWarnings(chunks: KnowledgeChunk[], secretFound: boolean): KnowledgeWarning[] {
  const warnings: KnowledgeWarning[] = [];
  if (secretFound) {
    warnings.push({
      code: 'SECRET_REDACTED',
      message: '检测到疑似明文密钥；导入内容已用 [REDACTED_SECRET] 替代。'
    });
  }
  const injectionChunks = chunks.filter((chunk) => isPromptInjectionLikeText(chunk.markdown));
  if (injectionChunks.length) {
    warnings.push({
      code: 'PROMPT_INJECTION_LIKE_TEXT',
      message: '文件包含疑似对 AI 发出的指令；已作为不可信引用文本保留，未执行。',
      chunkIds: injectionChunks.map((chunk) => chunk.id)
    });
  }
  return warnings;
}

function buildResult(input: {
  fileName: string;
  sourceExtension: '.pdf' | '.vtt' | '.srt' | '.txt';
  mimeType: string;
  bufferLength: number;
  observedAt?: string;
  title: string;
  author?: string | null;
  publishedAt?: string | null;
  updatedAt?: string | null;
  sections: LocatedSection[];
  extraWarnings?: KnowledgeWarning[];
  secretFound: boolean;
}): KnowledgeResult {
  const sourceUrl = buildLocalSourceIdentity(input.fileName, input.sourceExtension);
  const fetchedAt = normalizeObservedAt(input.observedAt);
  const chunks = createChunks(input.sections, sourceUrl);
  const markdown = `# ${input.title}\n\n${input.sections.map((section) => section.markdown).join('\n\n')}`.trim();
  const keyFacts = buildFacts(chunks);
  const warnings = [
    ...createWarnings(chunks, input.secretFound),
    ...(input.extraWarnings ?? []),
    {
      code: 'LOCAL_ONLY_INGESTION',
      message: '文件仅在本地 Buffer 中解析；结果不代表已获得内容版权，也未上传原文件。'
    }
  ];
  const firstText = chunks[0]?.markdown.replace(/^#{1,6}\s+.*$/gm, '').trim();

  return {
    schemaVersion: '0.1',
    packageId: crypto.randomUUID(),
    name: input.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 80) || 'local-knowledge',
    sourceKind: input.mimeType === 'application/pdf' ? 'pdf' : 'transcript',
    snapshot: {
      requestedUrl: sourceUrl,
      finalUrl: sourceUrl,
      fetchedAt,
      status: 200,
      contentType: input.mimeType,
      contentLength: input.bufferLength,
      contentHash: `sha256:${hash(markdown)}`,
      title: input.title,
      author: input.author ?? null,
      publishedAt: input.publishedAt ?? null,
      updatedAt: input.updatedAt ?? null
    },
    markdown,
    summary: firstText
      ? firstText.replace(/\s+/g, ' ').slice(0, 280)
      : `已从本地文件《${input.title}》提取可定位内容。`,
    keyFacts,
    chunks,
    warnings
  };
}

function normalizePdfOutput(output: PdfParseOutput): PdfParseOutput {
  if (!output || !Array.isArray(output.pages)) {
    throw new IngestionError('PDF_PAGE_LOCATION_UNAVAILABLE', 'PDF 解析器没有返回逐页文本。', '请使用支持逐页输出的 PDF 解析器，以保留页码来源。');
  }
  if (output.pages.length > INGESTION_LIMITS.maxPdfPages) {
    throw new IngestionError(
      'PDF_PAGE_LIMIT_EXCEEDED',
      `PDF 超过 ${INGESTION_LIMITS.maxPdfPages} 页解析限制。`,
      '请拆分 PDF 后重试。'
    );
  }
  const seen = new Set<number>();
  const pages = output.pages
    .map((page) => ({ pageNumber: Number(page.pageNumber), text: String(page.text ?? '').trim() }))
    .filter((page) => page.text.length > 0)
    .sort((a, b) => a.pageNumber - b.pageNumber);
  for (const page of pages) {
    if (!Number.isSafeInteger(page.pageNumber) || page.pageNumber < 1 || seen.has(page.pageNumber)) {
      throw new IngestionError('INVALID_PDF_PAGE_NUMBER', 'PDF 解析器返回了无效或重复页码。', '请更换支持稳定逐页输出的解析器。');
    }
    seen.add(page.pageNumber);
  }
  const characters = pages.reduce((total, page) => total + page.text.length, 0);
  if (!pages.length) {
    throw new IngestionError('PDF_NO_TEXT', 'PDF 中没有可提取的文本。', '扫描版 PDF 请先在本地完成 OCR，再重新导入。');
  }
  if (characters > INGESTION_LIMITS.maxExtractedCharacters) {
    throw new IngestionError('EXTRACTED_TEXT_TOO_LARGE', 'PDF 提取文本超过本地处理限制。', '请拆分 PDF 后重试。');
  }
  return { ...output, pages };
}

async function importPdfParse(): Promise<Record<string, unknown>> {
  try {
    return await import('pdf-parse') as unknown as Record<string, unknown>;
  } catch {
    throw new IngestionError(
      'PDF_PARSER_UNAVAILABLE',
      '本地环境尚未安装 PDF 文本解析器。',
      '安装 pdf-parse，或通过 parser 参数注入支持逐页文本的本地解析器；文件不会上传。'
    );
  }
}

function metadataValue(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Loads pdf-parse only when PDF support is used. Both the classic function API and
 * the current PDFParse class API are supported; neither executes document scripts.
 */
export const defaultPdfParser: PdfParser = async (buffer) => {
  const module = await importPdfParse();
  const PDFParse = module.PDFParse;
  if (typeof PDFParse === 'function') {
    const Parser = PDFParse as new (options: { data: Uint8Array }) => {
      getText: () => Promise<Record<string, unknown>>;
      getInfo?: () => Promise<Record<string, unknown>>;
      destroy?: () => Promise<void> | void;
    };
    const parser = new Parser({ data: new Uint8Array(buffer) });
    try {
      const details: Record<string, unknown> = await (parser.getInfo?.() ?? Promise.resolve({}));
      const totalPages = Number(details.total ?? 0);
      if (Number.isFinite(totalPages) && totalPages > INGESTION_LIMITS.maxPdfPages) {
        throw new IngestionError(
          'PDF_PAGE_LIMIT_EXCEEDED',
          `PDF 超过 ${INGESTION_LIMITS.maxPdfPages} 页解析限制。`,
          '请拆分 PDF 后重试。'
        );
      }
      const parsed = await parser.getText();
      const rawPages = Array.isArray(parsed.pages) ? parsed.pages : [];
      const pages = rawPages.map((page, index) => {
        const item = page as Record<string, unknown>;
        return {
          pageNumber: Number(item.num ?? item.pageNumber ?? index + 1),
          text: String(item.text ?? '')
        };
      });
      const info = details.info as Record<string, unknown> | undefined;
      const getDateNode = details.getDateNode;
      const dates = typeof getDateNode === 'function'
        ? (getDateNode as () => Record<string, unknown>).call(details)
        : undefined;
      const createdAt = dates?.CreationDate instanceof Date
        ? dates.CreationDate.toISOString()
        : metadataValue(info, 'CreationDate');
      const updatedAt = dates?.ModDate instanceof Date
        ? dates.ModDate.toISOString()
        : metadataValue(info, 'ModDate');
      return {
        pages,
        title: metadataValue(info, 'Title'),
        author: metadataValue(info, 'Author'),
        createdAt,
        updatedAt
      };
    } finally {
      await parser.destroy?.();
    }
  }

  const classic = (typeof module.default === 'function' ? module.default : module) as unknown;
  if (typeof classic !== 'function') {
    throw new IngestionError('PDF_PARSER_INCOMPATIBLE', '已安装的 PDF 解析器接口不受支持。', '请升级 pdf-parse，或注入逐页解析器。');
  }
  const pages: PdfPageText[] = [];
  let pageNumber = 0;
  const parsed = await (classic as (
    data: Buffer,
    options: { pagerender: (page: Record<string, unknown>) => Promise<string> }
  ) => Promise<Record<string, unknown>>)(buffer, {
    pagerender: async (page) => {
      pageNumber += 1;
      const getTextContent = page.getTextContent;
      if (typeof getTextContent !== 'function') return '';
      const content = await (getTextContent as (options: Record<string, boolean>) => Promise<Record<string, unknown>>)
        .call(page, { normalizeWhitespace: true, disableCombineTextItems: false });
      const items = Array.isArray(content.items) ? content.items : [];
      const text = items.map((item) => {
        const record = item as Record<string, unknown>;
        return `${String(record.str ?? '')}${record.hasEOL ? '\n' : ' '}`;
      }).join('').replace(/[ \t]+\n/g, '\n').trim();
      pages.push({ pageNumber, text });
      return text;
    }
  });
  const info = parsed.info;
  return {
    pages,
    title: metadataValue(info, 'Title'),
    author: metadataValue(info, 'Author'),
    createdAt: metadataValue(info, 'CreationDate'),
    updatedAt: metadataValue(info, 'ModDate')
  };
};

export async function ingestPdfBuffer(input: PdfIngestionInput): Promise<KnowledgeResult> {
  ensureBuffer(input.buffer, INGESTION_LIMITS.maxPdfBytes, 'PDF');
  const fileName = cleanFileName(input.fileName);
  if (!input.buffer.subarray(0, 1024).toString('latin1').includes('%PDF-')) {
    throw new IngestionError('INVALID_PDF_SIGNATURE', '文件不是有效的 PDF。', '请确认扩展名与文件内容一致。');
  }

  let parsed: PdfParseOutput;
  try {
    parsed = normalizePdfOutput(await (input.parser ?? defaultPdfParser)(input.buffer));
  } catch (error) {
    if (error instanceof IngestionError) throw error;
    throw new IngestionError(
      'PDF_PARSE_FAILED',
      '无法安全解析该 PDF。',
      '文件可能已加密、损坏或只包含扫描图像；请先解密或在本地完成 OCR。'
    );
  }

  let secretFound = false;
  const fallbackTitle = path.basename(fileName, path.extname(fileName));
  const titleScan = redactSecrets(safeMetadata(parsed.title, fallbackTitle));
  const authorScan = redactSecrets(safeMetadata(parsed.author) || '');
  secretFound ||= titleScan.found || authorScan.found;
  const title = titleScan.text;
  const sections = parsed.pages.map((page) => {
    const redacted = redactSecrets(escapeMarkdownHtml(page.text));
    secretFound ||= redacted.found;
    return {
      title: `第 ${page.pageNumber} 页`,
      titlePath: [title, `第 ${page.pageNumber} 页`],
      markdown: `## 第 ${page.pageNumber} 页\n\n${redacted.text}`,
      locator: `pdf:page=${page.pageNumber}`
    };
  });
  const activeContent = /\/(?:JavaScript|JS|Launch|EmbeddedFile)\b/.test(input.buffer.toString('latin1'));

  return buildResult({
    fileName,
    sourceExtension: '.pdf',
    mimeType: input.mimeType?.split(';')[0].trim() || 'application/pdf',
    bufferLength: input.buffer.length,
    observedAt: input.observedAt,
    title,
    author: authorScan.text || null,
    publishedAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    sections,
    secretFound,
    extraWarnings: activeContent ? [{
      code: 'PDF_ACTIVE_CONTENT_IGNORED',
      message: 'PDF 声明了脚本、启动动作或嵌入文件；解析器仅提取文本，未执行或打开这些内容。'
    }] : undefined
  });
}

function parseTimestamp(value: string): { normalized: string; milliseconds: number } {
  const match = value.trim().replace(',', '.').match(/^(?:(\d{1,3}):)?(\d{2}):(\d{2})\.(\d{3})$/);
  if (!match) {
    throw new IngestionError('INVALID_TIMECODE', `无法识别时间码：${value.trim() || '空'}。`, '请使用 WebVTT 或 SRT 标准时间码。');
  }
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number(match[4]);
  if (minutes > 59 || seconds > 59) {
    throw new IngestionError('INVALID_TIMECODE', `时间码超出有效范围：${value.trim()}。`, '请修正转录时间码后重试。');
  }
  return {
    normalized: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`,
    milliseconds: (((hours * 60) + minutes) * 60 + seconds) * 1000 + millis
  };
}

function parseTimedTranscript(text: string, format: 'vtt' | 'srt'): TranscriptCue[] {
  const normalizedText = text.replace(/\r\n?/g, '\n').trim();
  if (format === 'vtt' && !normalizedText.startsWith('WEBVTT')) {
    throw new IngestionError('INVALID_VTT_HEADER', 'WebVTT 文件缺少 WEBVTT 头。', '请导出标准 .vtt 转录文件。');
  }
  const blocks = normalizedText.split(/\n{2,}/);
  const cues: TranscriptCue[] = [];
  for (const rawBlock of blocks) {
    const lines = rawBlock.split('\n').map((line) => line.trimEnd());
    const first = lines[0]?.trim() ?? '';
    if (!first || first === 'WEBVTT' || first.startsWith('WEBVTT ') || /^(NOTE|STYLE|REGION)(?:\s|$)/.test(first)) continue;
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex].match(/^\s*([^\s]+)\s+-->\s+([^\s]+)(?:\s+.*)?$/);
    if (!timing) {
      throw new IngestionError('INVALID_TIMECODE', `无法识别转录时间行：${lines[timingIndex]}。`, '请修正 WebVTT/SRT 时间码后重试。');
    }
    const start = parseTimestamp(timing[1]);
    const end = parseTimestamp(timing[2]);
    if (end.milliseconds <= start.milliseconds) {
      throw new IngestionError('INVALID_TIMECODE_RANGE', '转录片段结束时间必须晚于开始时间。', '请修正时间范围后重试。');
    }
    const cueText = plainText(lines.slice(timingIndex + 1).join('\n'));
    if (cueText) cues.push({ start: start.normalized, end: end.normalized, text: cueText });
    if (cues.length > INGESTION_LIMITS.maxTranscriptCues) {
      throw new IngestionError('TRANSCRIPT_CUE_LIMIT_EXCEEDED', '转录片段数量超过本地处理限制。', '请拆分转录文件后重试。');
    }
  }
  if (!cues.length) {
    throw new IngestionError('TRANSCRIPT_NO_CUES', '转录文件中没有可定位的时间片段。', '请确认文件包含标准时间码和字幕正文。');
  }
  return cues;
}

function parsePlainText(text: string): Array<{ startLine: number; endLine: number; text: string }> {
  const normalized = text.replace(/\r\n?/g, '\n');
  const sections: Array<{ startLine: number; endLine: number; text: string }> = [];
  let cursor = 0;
  let lineNumber = 1;
  let startLine = -1;
  let startOffset = -1;
  let lastContentLine = -1;
  let lastContentEnd = -1;
  const flush = () => {
    if (startLine < 0) return;
    const content = normalized.slice(startOffset, lastContentEnd).trim();
    if (content) {
      if (sections.length >= INGESTION_LIMITS.maxTranscriptSections) {
        throw new IngestionError(
          'TRANSCRIPT_SECTION_LIMIT_EXCEEDED',
          `TXT 段落数量超过 ${INGESTION_LIMITS.maxTranscriptSections} 个本地处理限制。`,
          '请合并过短段落或拆分转录文件后重试。'
        );
      }
      sections.push({ startLine, endLine: lastContentLine, text: content });
    }
    startLine = -1;
    startOffset = -1;
    lastContentLine = -1;
    lastContentEnd = -1;
  };

  while (cursor <= normalized.length) {
    const newline = normalized.indexOf('\n', cursor);
    const lineEnd = newline < 0 ? normalized.length : newline;
    const line = normalized.slice(cursor, lineEnd);
    if (!line.trim()) {
      flush();
    } else {
      if (startLine < 0) {
        startLine = lineNumber;
        startOffset = cursor;
      }
      lastContentLine = lineNumber;
      lastContentEnd = lineEnd;
    }
    if (newline < 0) break;
    cursor = newline + 1;
    lineNumber += 1;
  }
  flush();
  if (!sections.length) {
    throw new IngestionError('TRANSCRIPT_EMPTY', '文本文件没有可提取内容。', '请选择包含转录正文的 UTF-8 文本。');
  }
  return sections;
}

export function detectTranscriptFormat(fileName: string, mimeType = ''): TranscriptFormat {
  const extension = path.extname(cleanFileName(fileName)).toLowerCase();
  const mime = mimeType.toLowerCase().split(';')[0].trim();
  if (mime.startsWith('audio/') || mime.startsWith('video/') || RAW_MEDIA_EXTENSIONS.has(extension)) {
    throw new IngestionError(
      'RAW_MEDIA_TRANSCRIPTION_REQUIRED',
      'MVP 不会对原始音频或视频执行语音识别。',
      '请先在本地生成带时间码的 WebVTT/SRT 转录，或导出 UTF-8 TXT 后再导入。'
    );
  }
  if (extension === '.vtt' || mime === 'text/vtt') return 'vtt';
  if (extension === '.srt' || mime === 'application/x-subrip' || mime === 'text/srt') return 'srt';
  if (extension === '.txt' || mime === 'text/plain') return 'txt';
  throw new IngestionError('UNSUPPORTED_TRANSCRIPT_FORMAT', '不支持该转录文件格式。', '请选择 .vtt、.srt 或 UTF-8 .txt 文件。');
}

export function ingestTranscriptBuffer(input: LocalBufferInput): KnowledgeResult {
  ensureBuffer(input.buffer, INGESTION_LIMITS.maxTranscriptBytes, '转录');
  const fileName = cleanFileName(input.fileName);
  const format = detectTranscriptFormat(fileName, input.mimeType);
  const decoded = decodeUtf8(input.buffer);
  if (decoded.length > INGESTION_LIMITS.maxExtractedCharacters) {
    throw new IngestionError('EXTRACTED_TEXT_TOO_LARGE', '转录文本超过本地处理限制。', '请拆分转录文件后重试。');
  }
  const title = path.basename(fileName, path.extname(fileName));
  let secretFound = false;
  let sections: LocatedSection[];

  if (format === 'txt') {
    sections = parsePlainText(decoded).map((part) => {
      const redacted = redactSecrets(part.text);
      secretFound ||= redacted.found;
      const label = `文本 L${part.startLine}–L${part.endLine}`;
      return {
        title: label,
        titlePath: [title, label],
        markdown: `## ${label}\n\n${redacted.text}`,
        locator: `text:L${part.startLine}-L${part.endLine}`
      };
    });
  } else {
    sections = parseTimedTranscript(decoded, format).map((cue) => {
      const redacted = redactSecrets(cue.text);
      secretFound ||= redacted.found;
      const label = `${cue.start} → ${cue.end}`;
      return {
        title: label,
        titlePath: [title, label],
        markdown: `## ${label}\n\n${redacted.text}`,
        locator: `media:t=${cue.start}-${cue.end}`
      };
    });
  }

  const mimeType = format === 'vtt'
    ? 'text/vtt'
    : format === 'srt'
      ? 'application/x-subrip'
      : 'text/plain';
  return buildResult({
    fileName,
    sourceExtension: `.${format}`,
    mimeType,
    bufferLength: input.buffer.length,
    observedAt: input.observedAt,
    title,
    sections,
    secretFound,
    extraWarnings: format === 'txt' ? [{
      code: 'TRANSCRIPT_WITHOUT_TIMECODES',
      message: 'TXT 不包含媒体时间码；来源只能定位到文本行。若需媒体回溯，请改用 VTT/SRT。'
    }] : undefined
  });
}

export async function ingestLocalBuffer(input: PdfIngestionInput): Promise<KnowledgeResult> {
  const extension = path.extname(cleanFileName(input.fileName)).toLowerCase();
  const mime = input.mimeType?.toLowerCase().split(';')[0].trim() ?? '';
  if (extension === '.pdf' || mime === 'application/pdf') return ingestPdfBuffer(input);
  return ingestTranscriptBuffer(input);
}
