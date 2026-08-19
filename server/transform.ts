import crypto from 'node:crypto';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import type { ContextPackage, KeyFact, KnowledgeChunk, KnowledgeResult, KnowledgeWarning } from '../shared/types.js';
import { PRODUCT_VERSION } from '../shared/version.js';
import type { FetchedPage } from './fetcher.js';

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const shortHash = (value: string) => hash(value).slice(0, 16);
const SECRET_PATTERNS = [
  /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\b(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}["']?/gi
];

function redactSecrets(markdown: string): { markdown: string; found: boolean } {
  let found = false;
  let redacted = markdown;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, () => {
      found = true;
      return '[REDACTED_SECRET]';
    });
  }
  return { markdown: redacted, found };
}

function findMeta(document: Document, selectors: string[]): string | null {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    const value = element?.getAttribute('content') ?? element?.textContent;
    if (value?.trim()) return value.trim();
  }
  return null;
}

function createTurndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
    strongDelimiter: '**'
  });
  service.addRule('fencedCodeWithLanguage', {
    filter: (node) => node.nodeName === 'PRE',
    replacement: (_content, node) => {
      const pre = node as HTMLElement;
      const code = pre.querySelector('code');
      const language = pre.dataset.language ?? '';
      return `\n\n\`\`\`${language}\n${(code?.textContent ?? pre.textContent ?? '').replace(/\n$/, '')}\n\`\`\`\n\n`;
    }
  });
  return service;
}

export function splitMarkdown(markdown: string, url: string): KnowledgeChunk[] {
  const lines = markdown.split('\n');
  const chunks: KnowledgeChunk[] = [];
  const idOccurrences = new Map<string, number>();
  let headings: string[] = [];
  let start = 1;
  let buffer: string[] = [];

  const flush = (end: number) => {
    const content = buffer.join('\n').trim();
    if (!content) return;
    const title = headings.at(-1) ?? '正文';
    const titlePath = headings.length ? [...headings] : ['正文'];
    const revision = `sha256:${hash(content)}`;
    const idSignature = `${titlePath.join('>')}\n${content}`;
    const occurrence = (idOccurrences.get(idSignature) ?? 0) + 1;
    idOccurrences.set(idSignature, occurrence);
    chunks.push({
      id: `chunk-${shortHash(occurrence === 1 ? idSignature : `${idSignature}\noccurrence:${occurrence}`)}`,
      title,
      titlePath,
      markdown: content,
      revision,
      source: { url, locator: `markdown:L${start}-L${Math.max(start, end)}` }
    });
  };

  lines.forEach((line, index) => {
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flush(index);
      const level = heading[1].length;
      headings = [...headings.slice(0, level - 1), heading[2].trim()];
      start = index + 1;
      buffer = [line];
    } else {
      buffer.push(line);
    }
  });
  flush(lines.length);
  return chunks;
}

const PROMPT_INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|forget|disregard|override|bypass)\b.{0,48}\b(?:(?:(?:all|any|every)\s+)?(?:previous|prior|earlier|above)\s+(?:instructions?|rules?|directions?)|(?:all|any|every)\s+(?:instructions?|rules?|directions?)|instructions?|rules?|directions?|everything(?:\s+(?:above|before))?)\b/isu,
  /\b(?:(?:(?:all|any|every)\s+)?(?:previous|prior|earlier|above)\s+(?:instructions?|rules?|directions?)|(?:all|any|every)\s+(?:instructions?|rules?|directions?)|instructions?|rules?|directions?|everything(?:\s+(?:above|before))?)\b.{0,48}\b(?:ignore|ignored|forget|forgotten|disregard|disregarded|override|overridden|bypass|bypassed)\b/isu,
  /\b(?:reveal|expose|leak|print|return|send|read)\b.{0,48}\b(?:credentials?|secrets?|tokens?|passwords?|system\s+prompts?)\b/isu,
  /\b(?:credentials?|secrets?|tokens?|passwords?|system\s+prompts?)\b.{0,48}\b(?:reveal|revealed|expose|exposed|leak|leaked|print|printed|return|returned|send|sent|read)\b/isu,
  /忽略(?:以上|之前|前面|所有)?(?:的)?(?:规则|指令|要求)/u,
  /(?:(?:丢掉|忘掉|无视|忽略|绕过).{0,24}(?:所有|以上|之前|前面)?(?:的)?(?:规则|指令|要求)|(?:所有|以上|之前|前面)?(?:的)?(?:规则|指令|要求).{0,20}(?:丢掉|忘掉|无视|忽略|绕过))/u,
  /system\s+prompts?/iu,
  /(?:读取|泄露|输出|发送|返回|展示).{0,20}(?:密钥|密码|凭据|令牌|系统提示|\/etc\/passwd)/u,
  /(?:密钥|密码|凭据|令牌|系统提示|\/etc\/passwd).{0,20}(?:读取|泄露|输出|发送|返回|展示)/u,
  /你(?:现在|必须|应该).{0,16}(?:执行|遵循|输出|访问|读取)/u
];

export function isPromptInjectionLikeText(value: string): boolean {
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(value));
}

function detectWarnings(chunks: KnowledgeChunk[]): KnowledgeWarning[] {
  const affected = chunks.filter((chunk) => isPromptInjectionLikeText(chunk.markdown));
  return affected.length ? [{
    code: 'PROMPT_INJECTION_LIKE_TEXT',
    message: '页面包含疑似对 AI 发出的指令；已作为不可信引用文本保留，未执行。',
    chunkIds: affected.map((chunk) => chunk.id)
  }] : [];
}

/**
 * Facts are an allowlist, not a text-classification result. External HTML,
 * uploads and API payloads are untrusted even when they look declarative, and
 * no language/Unicode heuristic can prove that an arbitrary sentence is safe
 * or true.
 *
 * This version has no server-held trusted-source registry or reviewed approval
 * store, so the allowlist is deliberately empty. Keep the KeyFact field for
 * schema compatibility, but do not invent a client-supplied confirmation
 * escape hatch. A future fact workflow must bind an approval to source URL,
 * chunk id, revision and exact statement outside the request payload.
 */
export function buildFacts(_chunks: KnowledgeChunk[]): KeyFact[] {
  return [];
}

export function transformHtml(page: FetchedPage): KnowledgeResult {
  const dom = new JSDOM(page.html, { url: page.finalUrl });
  const sourceDocument = dom.window.document;
  sourceDocument.querySelectorAll('script, style, noscript, iframe, object, embed, form').forEach((node) => node.remove());
  const codeLanguages = new Map<string, string>();
  sourceDocument.querySelectorAll('pre code').forEach((code) => {
    const language = code.className.match(/(?:language-|lang-)([\w-]+)/i)?.[1];
    if (language && code.textContent) codeLanguages.set(code.textContent.trim(), language);
  });

  const metadata = {
    author: findMeta(sourceDocument, ['meta[name="author"]', 'meta[property="article:author"]']),
    publishedAt: findMeta(sourceDocument, ['meta[property="article:published_time"]', 'time[datetime]']),
    updatedAt: findMeta(sourceDocument, ['meta[property="article:modified_time"]', 'meta[name="last-modified"]'])
  };
  const article = new Readability(sourceDocument.cloneNode(true) as Document).parse();
  if (!article?.content || !article.textContent?.trim()) {
    throw new Error('无法从该页面识别出可读正文。');
  }

  const cleanDom = new JSDOM(`<article>${article.content}</article>`, { url: page.finalUrl });
  cleanDom.window.document.querySelectorAll('script, style, iframe, object, embed, form').forEach((node) => node.remove());
  cleanDom.window.document.querySelectorAll('pre').forEach((pre) => {
    const language = codeLanguages.get(pre.textContent?.trim() ?? '');
    if (language) (pre as HTMLElement).dataset.language = language;
  });
  const rawMarkdownBody = createTurndown().turndown(cleanDom.window.document.querySelector('article')!);
  const secretScan = redactSecrets(rawMarkdownBody);
  const markdownBody = secretScan.markdown;
  const title = article.title?.trim() || sourceDocument.title.trim() || new URL(page.finalUrl).hostname;
  const markdown = markdownBody.match(/^#\s+/) ? markdownBody.trim() : `# ${title}\n\n${markdownBody.trim()}`;
  const contentHash = `sha256:${hash(markdown)}`;
  const chunks = splitMarkdown(markdown, page.finalUrl);
  const keyFacts = buildFacts(chunks);
  const warnings = detectWarnings(chunks);
  if (secretScan.found) warnings.unshift({
    code: 'SECRET_REDACTED',
    message: '检测到疑似明文密钥；导出内容已用 [REDACTED_SECRET] 替代。'
  });
  const packageId = crypto.randomUUID();
  const summary = article.excerpt?.trim() || keyFacts[0]?.statement || `已提取《${title}》的公开正文。`;

  return {
    schemaVersion: '0.1',
    packageId,
    name: title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 80) || 'web-knowledge',
    sourceKind: 'web',
    snapshot: {
      requestedUrl: page.requestedUrl,
      finalUrl: page.finalUrl,
      fetchedAt: page.fetchedAt,
      status: page.status,
      contentType: page.contentType,
      contentLength: page.contentLength,
      contentHash,
      title,
      author: metadata.author ?? article.byline ?? null,
      publishedAt: metadata.publishedAt,
      updatedAt: metadata.updatedAt
    },
    markdown,
    summary,
    keyFacts,
    chunks,
    warnings
  };
}

export function toContextPackage(result: KnowledgeResult): ContextPackage {
  const webSource = result.sourceKind === 'web' || result.sourceKind === 'site' || !result.sourceKind;
  const sourceTag = result.sourceKind ?? 'web';
  // Never trust result.keyFacts from a deserialized result. Context export has
  // an independent reference-only boundary until a server-held approval store
  // exists and is reviewed together with this code path.
  return {
    schemaVersion: '0.1',
    packageId: result.packageId,
    name: result.name,
    kind: result.sourceKind === 'web' || !result.sourceKind ? 'web' : 'mixed',
    createdAt: result.snapshot.fetchedAt,
    producer: { name: 'page2knowledge', version: PRODUCT_VERSION },
    items: [
      ...result.chunks.map((chunk) => ({
        id: chunk.id,
        type: 'reference' as const,
        title: chunk.title,
        content: chunk.markdown,
        scope: 'project' as const,
        source: { uri: chunk.source.url, revision: chunk.revision, locator: `${chunk.titlePath.join(' > ')}; ${chunk.source.locator}` },
        validity: { observedAt: result.snapshot.fetchedAt, expiresAt: null, confidence: 1 },
        sensitivity: webSource ? 'public' as const : 'internal' as const,
        tags: [sourceTag, 'untrusted-source', 'reference-only', ...chunk.titlePath]
      }))
    ],
    warnings: [
      webSource
        ? '内容版权仍归原权利人所有；此包仅记录公开页面的本地转换结果。'
        : '本地文件可能包含非公开内容；已默认标为 internal，请在导出和共享前确认权限与敏感性。',
      '事实准入默认关闭：未经可信来源逐条确认的内容仅作为 reference，不自动导出为 fact。',
      ...result.warnings.map((warning) => warning.message)
    ]
  };
}
