import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import multer from 'multer';
import { fetchPublicHtml } from './fetcher.js';
import { FetchPolicyError } from './security.js';
import { buildFacts, toContextPackage, transformHtml } from './transform.js';
import { compareKnowledgeVersions, createFilteredKnowledgeExport, editKnowledgeChunkTitle, VersioningError } from './versioning.js';
import { crawlWebsite, CrawlPolicyError, type WebsiteCrawlResult } from './crawler.js';
import { ingestLocalBuffer, IngestionError } from './ingestion.js';
import { MediaTranscriptionError, transcribeMediaBuffer } from './media.js';
import { LocalKnowledgeBase } from './knowledge.js';
import { LocalFetchScheduler, SchedulePolicyError, type ScheduleTask } from './scheduler.js';
import type { ApiError, KnowledgeResult } from '../shared/types.js';
import { PRODUCT_VERSION } from '../shared/version.js';
import { createRequestOriginGuard } from './request-origin.js';

const rootDirectory = process.cwd();
const dataDirectory = path.resolve(process.env.PAGE2KNOWLEDGE_DATA_DIR || path.join(rootDirectory, '.data'));
const knowledgePath = process.env.PAGE2KNOWLEDGE_KNOWLEDGE_PATH || path.join(dataDirectory, 'knowledge-store.json');
const schedulerPath = process.env.PAGE2KNOWLEDGE_SCHEDULER_PATH || path.join(dataDirectory, 'scheduler-state.json');
const PDF_UPLOAD_BYTES = 20 * 1024 * 1024;
const TRANSCRIPT_UPLOAD_BYTES = 5 * 1024 * 1024;
const MEDIA_UPLOAD_BYTES = 250 * 1024 * 1024;
const TRANSCRIPT_EXTENSIONS = new Set(['.vtt', '.srt', '.txt']);
const MEDIA_EXTENSIONS = new Set(['.mp3', '.mp4', '.m4a', '.wav', '.webm', '.mov', '.mkv', '.ogg', '.opus', '.flac']);

class UploadSizeLimitError extends Error {
  readonly code = 'UPLOAD_TYPE_LIMIT';

  constructor(public readonly limitBytes: number) {
    super(`上传文件超过 ${(limitBytes / 1024 / 1024).toFixed(0)} MB 类型限制。`);
    this.name = 'UploadSizeLimitError';
  }
}

export function uploadLimitFor(fileName: string, mimeType = ''): number {
  const extension = path.extname(path.basename(fileName)).toLowerCase();
  const mime = mimeType.toLowerCase().split(';')[0].trim();
  if (extension === '.pdf' || mime === 'application/pdf') return PDF_UPLOAD_BYTES;
  if (TRANSCRIPT_EXTENSIONS.has(extension)) return TRANSCRIPT_UPLOAD_BYTES;
  if (MEDIA_EXTENSIONS.has(extension)) return MEDIA_UPLOAD_BYTES;
  if (!extension && (mime.startsWith('audio/') || mime.startsWith('video/'))) return MEDIA_UPLOAD_BYTES;
  if (!extension && mime.startsWith('text/')) return TRANSCRIPT_UPLOAD_BYTES;
  return TRANSCRIPT_UPLOAD_BYTES;
}

const boundedMemoryStorage: multer.StorageEngine = {
  _handleFile(_request, file, callback) {
    const limit = uploadLimitFor(file.originalname, file.mimetype);
    const chunks: Buffer[] = [];
    let size = 0;
    let completed = false;
    const finish = (error?: Error, info?: Partial<Express.Multer.File>) => {
      if (completed) return;
      completed = true;
      callback(error, info);
    };
    const onData = (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        file.stream.off('data', onData);
        file.stream.resume();
        finish(new UploadSizeLimitError(limit));
        return;
      }
      chunks.push(chunk);
    };
    file.stream.on('data', onData);
    file.stream.once('error', (error) => finish(error));
    file.stream.once('end', () => finish(undefined, { buffer: Buffer.concat(chunks, size), size }));
  },
  _removeFile(_request, file, callback) {
    delete (file as Partial<Express.Multer.File>).buffer;
    callback(null);
  }
};
const upload = multer({
  storage: boundedMemoryStorage,
  limits: { fileSize: MEDIA_UPLOAD_BYTES, files: 1, fields: 8 }
});

export const knowledgeBase = new LocalKnowledgeBase({ filePath: knowledgePath });
export const scheduler = new LocalFetchScheduler({
  statePath: schedulerPath,
  fetcher: async ({ url, previousRevision }) => {
    const result = transformHtml(await fetchPublicHtml(url));
    await knowledgeBase.upsertDocument({
      title: result.snapshot.title,
      url: result.snapshot.finalUrl,
      fetchedAt: result.snapshot.fetchedAt,
      revision: result.snapshot.contentHash,
      chunks: result.chunks
    });
    return {
      revision: result.snapshot.contentHash,
      changed: previousRevision !== result.snapshot.contentHash,
      itemCount: result.chunks.length,
      metadata: { title: result.snapshot.title }
    };
  }
});

function apiError(code: string, message: string, suggestion: string): ApiError {
  return { error: { code, message, suggestion } };
}

function maximumConcurrentHeavyOperations(): number {
  const configured = Number(process.env.PAGE2KNOWLEDGE_MAX_HEAVY_OPERATIONS ?? 1);
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= 4 ? configured : 1;
}

function createHeavyOperationGate() {
  let active = 0;
  const maximum = maximumConcurrentHeavyOperations();
  return (_request: Request, response: Response, next: NextFunction): void => {
    if (active >= maximum) {
      response.status(429).json(apiError(
        'HEAVY_OPERATION_BUSY',
        '已有高开销的上传、解析或站点抓取任务正在运行。',
        '请等待当前任务完成后重试；默认只并行处理一个高开销任务。'
      ));
      return;
    }
    active += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active -= 1;
    };
    response.once('finish', release);
    response.once('close', release);
    next();
  };
}

function safeEqualToken(received: string, expected: string): boolean {
  const left = crypto.createHash('sha256').update(received).digest();
  const right = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(left, right);
}

function configuredAccessToken(): string | null {
  const token = process.env.PAGE2KNOWLEDGE_ACCESS_TOKEN?.trim() ?? '';
  if (token && Buffer.byteLength(token, 'utf8') < 32) {
    throw new Error('PAGE2KNOWLEDGE_ACCESS_TOKEN 去除空白后必须至少包含 32 个 UTF-8 字节。');
  }
  if (!token && process.env.NODE_ENV === 'production') {
    throw new Error('生产模式必须配置 PAGE2KNOWLEDGE_ACCESS_TOKEN，且去除空白后至少包含 32 个 UTF-8 字节。');
  }
  return token || null;
}

function authenticate(expected: string | null) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!expected) return next();
    const cookie = request.headers.cookie ?? '';
    const tokenInCookie = /(?:^|;\s*)(?:access_token|token|page2knowledge_access_token)=/i.test(cookie);
    if (request.query.access_token || request.query.token || tokenInCookie) {
      response.status(401).json(apiError('AUTH_HEADER_REQUIRED', '访问令牌只能通过 Authorization 请求头传递。', '请勿把令牌放入 URL 或 Cookie。'));
      return;
    }
    const match = request.headers.authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match || !safeEqualToken(match[1], expected)) {
      response.status(401).json(apiError('UNAUTHORIZED', '访问令牌缺失或无效。', '请在当前会话中配置正确的 Bearer Token。'));
      return;
    }
    next();
  };
}

function combineCrawl(result: WebsiteCrawlResult): KnowledgeResult | null {
  if (!result.pages.length) return null;
  const chunks = result.pages.flatMap((page) => page.knowledge.chunks);
  // Crawl pages are untrusted even when a dependency or legacy payload
  // supplies keyFacts. Site aggregation must re-enter the same fail-closed
  // admission path as every other source.
  const keyFacts = buildFacts(chunks);
  const markdown = result.pages.map((page) => `# ${page.knowledge.snapshot.title}\n\n${page.knowledge.markdown}`).join('\n\n---\n\n');
  const first = result.pages[0].knowledge;
  return {
    schemaVersion: '0.1',
    packageId: crypto.randomUUID(),
    name: `${new URL(result.plan.startUrl).hostname}-site-knowledge`,
    sourceKind: 'site',
    snapshot: {
      requestedUrl: result.plan.startUrl,
      finalUrl: result.plan.startUrl,
      fetchedAt: result.completedAt,
      status: 200,
      contentType: 'text/html; collection=site',
      contentLength: Buffer.byteLength(markdown),
      contentHash: `sha256:${crypto.createHash('sha256').update(markdown).digest('hex')}`,
      title: `${new URL(result.plan.startUrl).hostname} 站点知识`,
      author: null,
      publishedAt: null,
      updatedAt: null
    },
    markdown,
    summary: `已在明确上限内处理 ${result.pages.length} 个同源页面；${result.skipped.length} 个地址被跳过。`,
    keyFacts,
    chunks,
    warnings: [
      ...result.pages.flatMap((page) => page.knowledge.warnings),
      ...result.skipped.slice(0, 20).map((item) => ({ code: `CRAWL_${item.reason}`, message: `${item.url}：${item.detail}` }))
    ]
  };
}

function scheduleView(task: ScheduleTask) {
  const lastStatus = task.lastFailureAt && (!task.lastSuccessAt || task.lastFailureAt > task.lastSuccessAt)
    ? 'failed'
    : task.lastSuccessAt ? 'success' : task.status === 'running' ? 'running' : 'never';
  return {
    id: task.id,
    url: task.url,
    intervalMinutes: task.intervalMs / 60_000,
    enabled: task.enabled,
    confirmedAt: task.createdAt,
    createdAt: task.createdAt,
    nextRunAt: task.nextRunAt,
    lastRunAt: task.lastAttemptAt,
    lastStatus,
    lastError: task.lastError,
    lastRevision: task.lastRevision,
    runCount: task.runCount
  };
}

export function createApp() {
  const accessToken = configuredAccessToken();
  const app = express();
  const heavyOperationGate = createHeavyOperationGate();
  app.disable('x-powered-by');
  // Security decisions use the direct Host/socket only. Forwarded,
  // X-Forwarded-Host and X-Forwarded-Proto are never trusted here.
  app.set('trust proxy', false);
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-origin' } }));
  if (process.env.NODE_ENV === 'production') {
    app.use((request, response, next) => {
      const requestId = String(request.headers['x-request-id'] ?? crypto.randomUUID()).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80) || crypto.randomUUID();
      const startedAt = performance.now();
      response.setHeader('x-request-id', requestId);
      response.on('finish', () => {
        if (request.path === '/api/health' && Math.random() > 0.05) return;
        console.log(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: response.statusCode >= 500 ? 'error' : response.statusCode >= 400 ? 'warn' : 'info',
          requestId,
          method: request.method,
          route: request.route?.path ?? request.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id'),
          status: response.statusCode,
          durationMs: Number((performance.now() - startedAt).toFixed(1))
        }));
      });
      next();
    });
  }
  app.use(createRequestOriginGuard());
  app.get('/api/health', (_request, response) => response.json({
    status: 'ok',
    version: PRODUCT_VERSION,
    authRequired: Boolean(accessToken)
  }));
  app.use('/api', rateLimit({ windowMs: 15 * 60_000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false }));
  app.use('/api', authenticate(accessToken));
  app.use(express.json({ limit: '25mb' }));

  app.get('/api/example', async (_request, response, next) => {
    try {
      const html = await fs.readFile(path.join(rootDirectory, 'samples/technical-document.html'), 'utf8');
      const result = transformHtml({ requestedUrl: 'https://docs.example.com/quickstart', finalUrl: 'https://docs.example.com/quickstart', status: 200, contentType: 'text/html; charset=utf-8', contentLength: Buffer.byteLength(html), html, fetchedAt: '2026-08-12T12:00:00.000Z' });
      response.json({ ...result, contextPackage: toContextPackage(result) });
    } catch (error) { next(error); }
  });

  app.get('/api/example/versions', async (_request, response, next) => {
    try {
      const [beforeHtml, afterHtml] = await Promise.all([
        fs.readFile(path.join(rootDirectory, 'samples/technical-document.html'), 'utf8'),
        fs.readFile(path.join(rootDirectory, 'samples/technical-document-v2.html'), 'utf8')
      ]);
      const make = (html: string, fetchedAt: string) => transformHtml({ requestedUrl: 'https://docs.example.com/quickstart', finalUrl: 'https://docs.example.com/quickstart', status: 200, contentType: 'text/html; charset=utf-8', contentLength: Buffer.byteLength(html), html, fetchedAt });
      const before = make(beforeHtml, '2026-08-10T12:00:00.000Z');
      const after = make(afterHtml, '2026-08-12T13:00:00.000Z');
      response.json({ before: { ...before, contextPackage: toContextPackage(before) }, after: { ...after, contextPackage: toContextPackage(after) }, diff: compareKnowledgeVersions(before, after) });
    } catch (error) { next(error); }
  });

  app.post('/api/extract', async (request, response, next) => {
    const input = typeof request.body?.url === 'string' ? request.body.url.trim() : '';
    if (!input) return response.status(400).json(apiError('URL_REQUIRED', '请输入公开网页地址。', '请输入完整的 HTTP 或 HTTPS URL。'));
    try {
      const result = transformHtml(await fetchPublicHtml(input));
      response.json({ ...result, contextPackage: toContextPackage(result) });
    } catch (error) { next(error); }
  });

  app.post('/api/versions/compare', (request, response, next) => {
    try { response.json(compareKnowledgeVersions(request.body.before, request.body.after)); } catch (error) { next(error); }
  });
  app.post('/api/exports/filter', (request, response, next) => {
    try { response.json(createFilteredKnowledgeExport(request.body.result, request.body.excludedChunkIds ?? [])); } catch (error) { next(error); }
  });
  app.post('/api/exports/edit-title', (request, response, next) => {
    try { response.json(editKnowledgeChunkTitle(request.body.result, String(request.body.chunkId ?? ''), String(request.body.title ?? ''))); } catch (error) { next(error); }
  });

  app.post('/api/ingest', heavyOperationGate, upload.single('file'), async (request, response, next) => {
    if (!request.file) return response.status(400).json(apiError('FILE_REQUIRED', '请选择要导入的本地文件。', '支持 PDF、VTT、SRT、TXT 及常见音视频格式。'));
    try {
      const transcribe = request.body.transcribe === 'true';
      const isPdf = request.file.mimetype === 'application/pdf' || request.file.originalname.toLowerCase().endsWith('.pdf');
      const result = transcribe
        ? await transcribeMediaBuffer({ buffer: request.file.buffer, fileName: request.file.originalname, language: request.body.language, model: request.body.model })
        : await ingestLocalBuffer({ buffer: request.file.buffer, fileName: request.file.originalname, mimeType: isPdf ? 'application/pdf' : request.file.mimetype });
      response.json({ ...result, contextPackage: toContextPackage(result) });
    } catch (error) { next(error); }
  });

  app.post('/api/crawl', heavyOperationGate, async (request, response, next) => {
    try {
      const crawl = await crawlWebsite(request.body.url, { maxPages: request.body.maxPages, maxDepth: request.body.maxDepth });
      const combined = combineCrawl(crawl);
      response.json({ ...crawl, combined: combined ? { ...combined, contextPackage: toContextPackage(combined) } : null });
    } catch (error) { next(error); }
  });

  app.get('/api/knowledge/stats', async (_request, response, next) => {
    try {
      const documents = await knowledgeBase.listDocuments();
      response.json({ documentCount: documents.length, chunkCount: documents.reduce((total, document) => total + document.chunks.length, 0), documents });
    } catch (error) { next(error); }
  });
  app.post('/api/knowledge/index', async (request, response, next) => {
    try {
      const result = request.body.result as KnowledgeResult;
      await knowledgeBase.upsertDocument({ id: `document-${crypto.createHash('sha256').update(result.snapshot.requestedUrl).digest('hex').slice(0, 20)}`, title: result.snapshot.title, url: result.snapshot.finalUrl, fetchedAt: result.snapshot.fetchedAt, revision: result.snapshot.contentHash, chunks: result.chunks });
      const documents = await knowledgeBase.listDocuments();
      response.json({ documentCount: documents.length, chunkCount: documents.reduce((total, document) => total + document.chunks.length, 0) });
    } catch (error) { next(error); }
  });
  app.post('/api/knowledge/search', async (request, response, next) => {
    try {
      const results = await knowledgeBase.search(String(request.body.query ?? ''), { topK: request.body.limit, minScore: 0.02 });
      response.json({ hits: results.map((item) => ({ chunkId: item.chunk.id, score: item.score, title: item.chunk.title, content: item.chunk.markdown, source: item.source })) });
    } catch (error) { next(error); }
  });
  app.post('/api/knowledge/chat', async (request, response, next) => {
    try {
      const result = await knowledgeBase.chat(String(request.body.question ?? ''), { topK: request.body.limit, minScore: 0.02 });
      response.json({ answer: result.answer, grounded: !result.refused, citations: result.citations.map((item) => ({ index: item.number, chunkId: item.chunkId, label: item.titlePath.join(' / '), source: { url: item.url, locator: item.locator, revision: item.revision, titlePath: item.titlePath } })), hits: [], warnings: result.warnings });
    } catch (error) { next(error); }
  });

  app.get('/api/schedules', async (_request, response, next) => {
    try { response.json({ tasks: (await scheduler.listTasks()).map(scheduleView) }); } catch (error) { next(error); }
  });
  app.post('/api/schedules', async (request, response, next) => {
    try {
      const task = await scheduler.createTask({ url: request.body.url, intervalMs: Number(request.body.intervalMinutes) * 60_000, enabled: request.body.enabled, confirmed: request.body.confirmed });
      response.status(201).json(scheduleView(task));
    } catch (error) { next(error); }
  });
  app.post('/api/schedules/:id/run', async (request, response, next) => {
    try { response.json(await scheduler.runTask(request.params.id, { force: true })); } catch (error) { next(error); }
  });
  app.delete('/api/schedules/:id', async (request, response, next) => {
    try { response.json(scheduleView(await scheduler.disableTask(request.params.id))); } catch (error) { next(error); }
  });

  if (process.env.NODE_ENV === 'production') {
    const webRoot = path.join(rootDirectory, 'dist');
    app.use(express.static(webRoot));
    app.get('*splat', (_request, response) => response.sendFile(path.join(webRoot, 'index.html')));
  }

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof UploadSizeLimitError) {
      return response.status(413).json(apiError(
        error.code,
        error.message,
        'PDF 上限为 20 MB，VTT/SRT/TXT 上限为 5 MB，音视频上限为 250 MB；请拆分或压缩后重试。'
      ));
    }
    if (error instanceof multer.MulterError) return response.status(413).json(apiError('UPLOAD_LIMIT', '上传文件超过限制。', '请压缩或拆分文件后重试。'));
    if (error instanceof FetchPolicyError || error instanceof CrawlPolicyError || error instanceof IngestionError || error instanceof MediaTranscriptionError || error instanceof VersioningError || error instanceof SchedulePolicyError) {
      const suggestion = 'suggestion' in error && typeof error.suggestion === 'string' ? error.suggestion : '请检查输入后重试。';
      return response.status(400).json(apiError(error.code, error.message, suggestion));
    }
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: 'error', code: 'REQUEST_FAILED', name: error instanceof Error ? error.name : 'UnknownError' }));
    response.status(422).json(apiError('REQUEST_FAILED', '请求处理失败。', '请检查输入与本地服务状态后重试。'));
  });
  return app;
}

export function startBackgroundScheduler(): NodeJS.Timeout {
  const timer = setInterval(() => { void scheduler.runDueTasks().catch((error) => console.error('scheduler tick failed', error)); }, 60_000);
  timer.unref();
  return timer;
}
