import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { JSDOM } from 'jsdom';
import type { KnowledgeResult } from '../shared/types.js';
import { crawlerUserAgent } from '../shared/version.js';
import { fetchPublicHtml, type FetchedPage, type FetchPublicHtmlOptions } from './fetcher.js';
import { parsePublicHttpUrl, resolvePublicAddresses } from './security.js';
import { transformHtml } from './transform.js';

export const CRAWL_HARD_LIMITS = {
  maxPages: 50,
  maxDepth: 5,
  maxDiscoveredUrls: 1_000,
  maxRobotsBytes: 512 * 1024,
  maxRobotsRules: 2_000,
  maxRobotsRuleLength: 2_048,
  maxExtractedBytes: 8 * 1024 * 1024,
  maxTotalChunks: 5_000,
  maxWallClockMs: 3 * 60_000,
  robotsTimeoutMs: 8_000,
  robotsRedirects: 3
} as const;

export type CrawlOptions = {
  maxPages?: number;
  maxDepth?: number;
  userAgent?: string;
};

export type CrawlPlan = {
  startUrl: string;
  origin: string;
  robotsUrl: string;
  maxPages: number;
  maxDepth: number;
  userAgent: string;
};

export type RobotsRule = {
  directive: 'allow' | 'disallow';
  path: string;
};

export type CrawledKnowledgePage = {
  url: string;
  finalUrl: string;
  depth: number;
  discoveredFrom: string | null;
  knowledge: KnowledgeResult;
};

export type CrawlSkip = {
  url: string;
  depth: number;
  reason:
    | 'ROBOTS_DISALLOWED'
    | 'CROSS_ORIGIN_REDIRECT'
    | 'FETCH_FAILED'
    | 'TRANSFORM_FAILED'
    | 'PAGE_LIMIT_REACHED';
  detail: string;
};

export type WebsiteCrawlResult = {
  plan: CrawlPlan;
  pages: CrawledKnowledgePage[];
  skipped: CrawlSkip[];
  robots: {
    fetched: boolean;
    ruleCount: number;
    rules: RobotsRule[];
  };
  attemptedPages: number;
  discoveredUrls: number;
  completedAt: string;
};

export type CrawlDependencies = {
  fetchPage?: (url: string, options?: FetchPublicHtmlOptions) => Promise<FetchedPage>;
  fetchRobots?: (url: string, userAgent: string) => Promise<string | null>;
  transformPage?: (page: FetchedPage) => KnowledgeResult;
  now?: () => Date;
};

type QueueItem = {
  url: string;
  depth: number;
  discoveredFrom: string | null;
};

type RobotsGroup = {
  agents: string[];
  rules: RobotsRule[];
};

const shortHash = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);

function namespacePageKnowledge(result: KnowledgeResult, sourceUrl: string): KnowledgeResult {
  const chunkIds = new Map(result.chunks.map((chunk) => [
    chunk.id,
    `chunk-${shortHash(`${sourceUrl}\n${chunk.id}`)}`
  ]));
  return {
    ...result,
    chunks: result.chunks.map((chunk) => ({
      ...chunk,
      id: chunkIds.get(chunk.id)!
    })),
    // A transform dependency may return a deserialized or legacy result. Do
    // not let its self-declared facts cross the crawl trust boundary.
    keyFacts: [],
    warnings: result.warnings.map((warning) => ({
      ...warning,
      chunkIds: warning.chunkIds?.map((id) => chunkIds.get(id) ?? id)
    }))
  };
}

export class CrawlPolicyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly suggestion: string
  ) {
    super(message);
    this.name = 'CrawlPolicyError';
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 0 || selected > maximum) {
    throw new CrawlPolicyError(
      'INVALID_CRAWL_LIMIT',
      `${label}必须是 0 到 ${maximum} 之间的整数。`,
      '请缩小爬取范围后重试。'
    );
  }
  return selected;
}

function canonicalUrl(input: string, base?: string): URL {
  const resolved = base ? new URL(input, base).toString() : input;
  const url = parsePublicHttpUrl(resolved);
  url.hash = '';
  return url;
}

export function createCrawlPlan(startUrl: string, options: CrawlOptions = {}): CrawlPlan {
  const start = canonicalUrl(startUrl);
  const maxPages = boundedInteger(options.maxPages, 10, CRAWL_HARD_LIMITS.maxPages, '最大页面数');
  if (maxPages < 1) {
    throw new CrawlPolicyError('INVALID_CRAWL_LIMIT', '最大页面数至少为 1。', '请设置 1 到 50 页的有限范围。');
  }
  const maxDepth = boundedInteger(options.maxDepth, 2, CRAWL_HARD_LIMITS.maxDepth, '最大深度');
  const userAgent = (options.userAgent ?? 'Page2Knowledge').trim();
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(userAgent)) {
    throw new CrawlPolicyError('INVALID_USER_AGENT', 'robots.txt 产品标识无效。', '请使用简短的字母数字产品标识。');
  }
  return {
    startUrl: start.toString(),
    origin: start.origin,
    robotsUrl: new URL('/robots.txt', start.origin).toString(),
    maxPages,
    maxDepth,
    userAgent
  };
}

/** Parse only the robots fields this MVP can enforce. Unknown directives are ignored. */
export function parseRobotsTxt(text: string, userAgent = 'Page2Knowledge'): RobotsRule[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let sawRules = false;
  let acceptedRules = 0;

  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === 'user-agent') {
      if (!current || sawRules) {
        current = { agents: [], rules: [] };
        groups.push(current);
        sawRules = false;
      }
      if (value) current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current || !current.agents.length || (key !== 'allow' && key !== 'disallow')) continue;
    sawRules = true;
    // An empty pattern matches no URI. In particular, an empty Allow must not
    // be converted to "/" because that could override a real Disallow: / rule.
    if (!value) continue;
    if (value.length > CRAWL_HARD_LIMITS.maxRobotsRuleLength) {
      throw new CrawlPolicyError(
        'ROBOTS_POLICY_LIMIT_EXCEEDED',
        `robots.txt 包含超过 ${CRAWL_HARD_LIMITS.maxRobotsRuleLength} 字符的规则，无法安全判定访问范围。`,
        '已停止整次爬取；请联系站点维护者简化 robots.txt 规则后重试。'
      );
    }
    if (acceptedRules >= CRAWL_HARD_LIMITS.maxRobotsRules) {
      throw new CrawlPolicyError(
        'ROBOTS_POLICY_LIMIT_EXCEEDED',
        `robots.txt 有效规则超过 ${CRAWL_HARD_LIMITS.maxRobotsRules} 条，无法安全判定访问范围。`,
        '已停止整次爬取；请缩小范围或联系站点维护者后重试。'
      );
    }
    current.rules.push({ directive: key, path: value });
    acceptedRules += 1;
  }

  const token = userAgent.toLowerCase();
  const longestMatch = groups.reduce((longest, group) => {
    const groupLongest = group.agents.reduce((length, agent) =>
      agent !== '*' && (token === agent || token.startsWith(agent))
        ? Math.max(length, agent.length)
        : length, 0);
    return Math.max(longest, groupLongest);
  }, 0);
  const selected = longestMatch > 0
    ? groups.filter((group) => group.agents.some((agent) =>
      agent !== '*' && agent.length === longestMatch && (token === agent || token.startsWith(agent))))
    : groups.filter((group) => group.agents.includes('*'));
  return selected.flatMap((group) => group.rules);
}

function robotsRuleMatches(pathAndQuery: string, pattern: string): boolean {
  const endAnchored = pattern.endsWith('$');
  const body = endAnchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  try {
    return new RegExp(`^${escaped}${endAnchored ? '$' : ''}`).test(pathAndQuery);
  } catch {
    return false;
  }
}

export function isAllowedByRobots(urlInput: string, rules: RobotsRule[]): boolean {
  const url = canonicalUrl(urlInput);
  const pathAndQuery = `${url.pathname}${url.search}`;
  const matches = rules
    .filter((rule) => robotsRuleMatches(pathAndQuery, rule.path))
    .map((rule) => ({
      ...rule,
      specificity: rule.path.replace(/[*$]/g, '').length
    }))
    .sort((a, b) => {
      const specificity = b.specificity - a.specificity;
      if (specificity) return specificity;
      if (a.directive === b.directive) return 0;
      return a.directive === 'allow' ? -1 : 1;
    });
  return matches[0]?.directive !== 'disallow';
}

export function discoverSameOriginLinks(html: string, baseUrl: string, origin: string): string[] {
  const document = new JSDOM(html).window.document;
  const found = new Set<string>();
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (anchor.getAttribute('rel')?.split(/\s+/).some((value) => value.toLowerCase() === 'nofollow')) continue;
    const href = anchor.getAttribute('href');
    if (!href) continue;
    try {
      const target = canonicalUrl(href, baseUrl);
      if (target.origin === origin) found.add(target.toString());
    } catch {
      // Invalid, private and non-HTTP links never enter the crawl queue.
    }
  }
  return [...found];
}

function robotsRequest(
  url: URL,
  address: string,
  family: number,
  userAgent: string
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, {
      method: 'GET',
      headers: {
        'user-agent': crawlerUserAgent(userAgent),
        accept: 'text/plain,*/*;q=0.1',
        'accept-encoding': 'identity'
      },
      lookup: (_hostname, _options, callback) => callback(null, address, family),
      signal: AbortSignal.timeout(CRAWL_HARD_LIMITS.robotsTimeoutMs)
    }, (response) => {
      const declaredLength = Number(response.headers['content-length'] ?? 0);
      if (declaredLength > CRAWL_HARD_LIMITS.maxRobotsBytes) {
        response.destroy();
        reject(new CrawlPolicyError('ROBOTS_TOO_LARGE', 'robots.txt 超过 512 KB 安全限制。', '已停止爬取，避免忽略站点规则。'));
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > CRAWL_HARD_LIMITS.maxRobotsBytes) {
          response.destroy(new CrawlPolicyError('ROBOTS_TOO_LARGE', 'robots.txt 超过 512 KB 安全限制。', '已停止爬取，避免忽略站点规则。'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
      response.on('error', reject);
    });
    request.on('error', (error) => {
      if (error instanceof CrawlPolicyError) reject(error);
      else reject(new CrawlPolicyError('ROBOTS_FETCH_FAILED', '无法安全读取 robots.txt。', '已停止爬取；请确认站点可公开访问后重试。'));
    });
    request.end();
  });
}

/** Safely fetch robots.txt with DNS pinning and redirect revalidation. */
export async function fetchPublicRobotsText(urlInput: string, userAgent = 'Page2Knowledge'): Promise<string | null> {
  const requested = canonicalUrl(urlInput);
  let current = requested;
  for (let redirect = 0; redirect <= CRAWL_HARD_LIMITS.robotsRedirects; redirect += 1) {
    if (current.origin !== requested.origin) {
      throw new CrawlPolicyError('CROSS_ORIGIN_ROBOTS_REDIRECT', 'robots.txt 重定向到了其他站点。', '已停止爬取，避免误用其他站点规则。');
    }
    const addresses = await resolvePublicAddresses(current.hostname);
    const response = await robotsRequest(current, addresses[0].address, addresses[0].family, userAgent);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirect === CRAWL_HARD_LIMITS.robotsRedirects || !response.headers.location) {
        throw new CrawlPolicyError('ROBOTS_REDIRECT_FAILED', 'robots.txt 重定向无效或次数过多。', '已停止爬取，避免忽略站点规则。');
      }
      current = canonicalUrl(response.headers.location, current.toString());
      continue;
    }
    if (response.status === 404 || (response.status >= 400 && response.status < 500 && ![401, 403, 429].includes(response.status))) {
      return null;
    }
    if ([401, 403].includes(response.status)) return 'User-agent: *\nDisallow: /';
    if (response.status < 200 || response.status >= 300) {
      throw new CrawlPolicyError('ROBOTS_HTTP_ERROR', `robots.txt 返回 HTTP ${response.status}。`, '已停止爬取；请稍后重试。');
    }
    return new TextDecoder('utf-8').decode(response.body).replace(/^\uFEFF/, '');
  }
  throw new CrawlPolicyError('ROBOTS_REDIRECT_FAILED', 'robots.txt 重定向次数过多。', '已停止爬取，避免忽略站点规则。');
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return '未知错误';
}

function crawlDeadlineError(): CrawlPolicyError {
  return new CrawlPolicyError(
    'CRAWL_DEADLINE_EXCEEDED',
    `站点爬取超过 ${CRAWL_HARD_LIMITS.maxWallClockMs / 60_000} 分钟总时限，已停止且不会返回部分大结果。`,
    '请减少最大页面数或深度，并确认目标站点能快速公开访问。'
  );
}

export async function crawlWebsite(
  startUrl: string,
  options: CrawlOptions = {},
  dependencies: CrawlDependencies = {}
): Promise<WebsiteCrawlResult> {
  const plan = createCrawlPlan(startUrl, options);
  const fetchPage = dependencies.fetchPage ?? fetchPublicHtml;
  const fetchRobots = dependencies.fetchRobots ?? fetchPublicRobotsText;
  const transformPage = dependencies.transformPage ?? transformHtml;
  const now = dependencies.now ?? (() => new Date());
  const startedAtMs = now().getTime();
  let totalExtractedBytes = 0;
  let totalChunks = 0;

  const remainingTimeMs = (): number => CRAWL_HARD_LIMITS.maxWallClockMs - Math.max(0, now().getTime() - startedAtMs);
  const assertWithinDeadline = (): void => {
    if (remainingTimeMs() <= 0) throw crawlDeadlineError();
  };
  const runWithinDeadline = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertWithinDeadline();
    const remaining = Math.max(1, remainingTimeMs());
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(crawlDeadlineError()), remaining);
        timer.unref();
      });
      const value = await Promise.race([operation(), timeout]);
      assertWithinDeadline();
      return value;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const robotsText = await runWithinDeadline(() => fetchRobots(plan.robotsUrl, plan.userAgent));
  const robotsRules = robotsText === null ? [] : parseRobotsTxt(robotsText, plan.userAgent);
  assertWithinDeadline();

  const queue: QueueItem[] = [{ url: plan.startUrl, depth: 0, discoveredFrom: null }];
  const queued = new Set([plan.startUrl]);
  const attempted = new Set<string>();
  const completedFinalUrls = new Set<string>();
  const pages: CrawledKnowledgePage[] = [];
  const skipped: CrawlSkip[] = [];
  const beforeRedirect: NonNullable<FetchPublicHtmlOptions['beforeRedirect']> = (next) => {
    const target = canonicalUrl(next.toString());
    if (target.origin !== plan.origin) {
      throw new CrawlPolicyError(
        'CROSS_ORIGIN_REDIRECT',
        `已在请求前阻止跨源重定向：${target.toString()}。`,
        '站点范围爬取只允许访问起始站点的同源页面。'
      );
    }
    if (!isAllowedByRobots(target.toString(), robotsRules)) {
      throw new CrawlPolicyError(
        'ROBOTS_DISALLOWED',
        `已在请求前阻止 robots.txt 禁止的重定向路径：${target.pathname}。`,
        '请移除该页面或遵守站点 robots.txt 规则。'
      );
    }
  };

  while (queue.length && attempted.size < plan.maxPages) {
    assertWithinDeadline();
    const item = queue.shift()!;
    if (!isAllowedByRobots(item.url, robotsRules)) {
      skipped.push({
        url: item.url,
        depth: item.depth,
        reason: 'ROBOTS_DISALLOWED',
        detail: 'robots.txt 的 Disallow 规则阻止了该路径。'
      });
      continue;
    }
    attempted.add(item.url);
    let fetched: FetchedPage;
    try {
      // Every HTML request, including injected tests, passes through this single dependency.
      // The production default is the existing SSRF-safe fetchPublicHtml implementation.
      fetched = await runWithinDeadline(() => fetchPage(item.url, { beforeRedirect }));
    } catch (error) {
      if (error instanceof CrawlPolicyError && error.code === 'CRAWL_DEADLINE_EXCEEDED') throw error;
      const reason = error instanceof CrawlPolicyError && error.code === 'CROSS_ORIGIN_REDIRECT'
        ? 'CROSS_ORIGIN_REDIRECT'
        : error instanceof CrawlPolicyError && error.code === 'ROBOTS_DISALLOWED'
          ? 'ROBOTS_DISALLOWED'
          : 'FETCH_FAILED';
      skipped.push({
        url: item.url,
        depth: item.depth,
        reason,
        detail: errorDetail(error)
      });
      continue;
    }

    let finalUrl: URL;
    try {
      finalUrl = canonicalUrl(fetched.finalUrl);
    } catch (error) {
      skipped.push({
        url: item.url,
        depth: item.depth,
        reason: 'FETCH_FAILED',
        detail: errorDetail(error)
      });
      continue;
    }
    if (finalUrl.origin !== plan.origin) {
      skipped.push({
        url: item.url,
        depth: item.depth,
        reason: 'CROSS_ORIGIN_REDIRECT',
        detail: `最终地址 ${finalUrl.toString()} 不属于起始站点。`
      });
      continue;
    }
    if (!isAllowedByRobots(finalUrl.toString(), robotsRules)) {
      skipped.push({
        url: item.url,
        depth: item.depth,
        reason: 'ROBOTS_DISALLOWED',
        detail: `重定向最终路径 ${finalUrl.pathname} 被 robots.txt 禁止。`
      });
      continue;
    }
    if (completedFinalUrls.has(finalUrl.toString())) continue;

    let transformed: KnowledgeResult;
    try {
      transformed = transformPage(fetched);
      assertWithinDeadline();
    } catch (error) {
      if (error instanceof CrawlPolicyError && error.code === 'CRAWL_DEADLINE_EXCEEDED') throw error;
      skipped.push({
        url: item.url,
        depth: item.depth,
        reason: 'TRANSFORM_FAILED',
        detail: errorDetail(error)
      });
      continue;
    }
    const pageExtractedBytes = Buffer.byteLength(transformed.markdown, 'utf8');
    if (totalExtractedBytes + pageExtractedBytes > CRAWL_HARD_LIMITS.maxExtractedBytes) {
      throw new CrawlPolicyError(
        'CRAWL_EXTRACTED_BYTES_LIMIT_EXCEEDED',
        `站点累计提取正文超过 ${CRAWL_HARD_LIMITS.maxExtractedBytes / 1024 / 1024} MB 安全上限，已停止且不会返回部分大结果。`,
        '请减少最大页面数、缩小深度或改为分批爬取。'
      );
    }
    if (totalChunks + transformed.chunks.length > CRAWL_HARD_LIMITS.maxTotalChunks) {
      throw new CrawlPolicyError(
        'CRAWL_CHUNK_LIMIT_EXCEEDED',
        `站点累计知识块超过 ${CRAWL_HARD_LIMITS.maxTotalChunks} 个安全上限，已停止且不会返回部分大结果。`,
        '请减少最大页面数、缩小深度或选择结构更集中的入口页面。'
      );
    }
    const knowledge = namespacePageKnowledge(transformed, finalUrl.toString());
    totalExtractedBytes += pageExtractedBytes;
    totalChunks += knowledge.chunks.length;
    completedFinalUrls.add(finalUrl.toString());
    pages.push({
      url: item.url,
      finalUrl: finalUrl.toString(),
      depth: item.depth,
      discoveredFrom: item.discoveredFrom,
      knowledge
    });

    if (item.depth >= plan.maxDepth) continue;
    const links = discoverSameOriginLinks(fetched.html, finalUrl.toString(), plan.origin);
    assertWithinDeadline();
    for (const link of links) {
      if (queued.size >= CRAWL_HARD_LIMITS.maxDiscoveredUrls) break;
      if (queued.has(link)) continue;
      queued.add(link);
      queue.push({ url: link, depth: item.depth + 1, discoveredFrom: finalUrl.toString() });
    }
  }

  assertWithinDeadline();
  if (queue.length) {
    for (const item of queue.slice(0, Math.max(0, CRAWL_HARD_LIMITS.maxDiscoveredUrls - skipped.length))) {
      skipped.push({
        url: item.url,
        depth: item.depth,
        reason: 'PAGE_LIMIT_REACHED',
        detail: `已达到最多 ${plan.maxPages} 次页面请求限制。`
      });
    }
  }

  assertWithinDeadline();
  return {
    plan,
    pages,
    skipped,
    robots: {
      fetched: robotsText !== null,
      ruleCount: robotsRules.length,
      rules: robotsRules
    },
    attemptedPages: attempted.size,
    discoveredUrls: queued.size,
    completedAt: now().toISOString()
  };
}

export const planWebsiteCrawl = createCrawlPlan;
export const executeWebsiteCrawl = crawlWebsite;
