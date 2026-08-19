import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { SINGLE_PAGE_USER_AGENT } from '../shared/version.js';
import { FetchPolicyError, parsePublicHttpUrl, resolvePublicAddresses } from './security.js';

export const FETCH_LIMITS = {
  timeoutMs: 12_000,
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 4
} as const;

export type FetchedPage = {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  contentLength: number;
  html: string;
  fetchedAt: string;
};

export type FetchPublicHtmlOptions = {
  beforeRedirect?: (next: URL, current: URL) => void | Promise<void>;
};

export function validateRedirect(location: string | undefined, current: URL): URL {
  if (!location) {
    throw new FetchPolicyError('INVALID_REDIRECT', '网页返回了缺少目标地址的重定向。', '请联系网站维护者或改用最终页面地址。');
  }
  return parsePublicHttpUrl(new URL(location, current).toString());
}

export function validateHtmlResponse(status: number, headers: IncomingHttpHeaders): string {
  if (status < 200 || status >= 300) {
    throw new FetchPolicyError('HTTP_ERROR', `目标网页返回 HTTP ${status}。`, '请确认页面无需登录且当前可公开访问。');
  }
  const declaredLength = Number(headers['content-length'] ?? 0);
  if (declaredLength > FETCH_LIMITS.maxBytes) {
    throw new FetchPolicyError('PAGE_TOO_LARGE', `网页超过 ${(FETCH_LIMITS.maxBytes / 1024 / 1024).toFixed(0)} MB 限制。`, '请选择较小的单篇正文页面。');
  }
  const contentType = String(headers['content-type'] ?? '').toLowerCase();
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    throw new FetchPolicyError('UNSUPPORTED_CONTENT_TYPE', `不支持的内容类型：${contentType || '未知'}。`, 'MVP 仅支持 HTML 网页，不支持 PDF、音视频或下载文件。');
  }
  return contentType;
}

function singleRequest(url: URL, address: string, family: number): Promise<{
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, {
      method: 'GET',
      headers: {
        'user-agent': SINGLE_PAGE_USER_AGENT,
        accept: 'text/html,application/xhtml+xml;q=0.9',
        'accept-encoding': 'identity'
      },
      lookup: (_hostname, _options, callback) => callback(null, address, family),
      signal: AbortSignal.timeout(FETCH_LIMITS.timeoutMs)
    }, (response) => {
      const declaredLength = Number(response.headers['content-length'] ?? 0);
      if (declaredLength > FETCH_LIMITS.maxBytes) {
        response.destroy();
        reject(new FetchPolicyError('PAGE_TOO_LARGE', `网页超过 ${(FETCH_LIMITS.maxBytes / 1024 / 1024).toFixed(0)} MB 限制。`, '请选择较小的单篇正文页面。'));
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > FETCH_LIMITS.maxBytes) {
          response.destroy(new FetchPolicyError('PAGE_TOO_LARGE', `网页超过 ${(FETCH_LIMITS.maxBytes / 1024 / 1024).toFixed(0)} MB 限制。`, '请选择较小的单篇正文页面。'));
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
      if (error instanceof FetchPolicyError) reject(error);
      else if (error.name === 'AbortError' || (error as NodeJS.ErrnoException).code === 'ABORT_ERR') {
        reject(new FetchPolicyError('FETCH_TIMEOUT', '抓取网页超时。', '请确认页面可公开访问，或稍后重试。'));
      } else {
        reject(new FetchPolicyError('NETWORK_ERROR', '无法连接目标网页。', '请检查地址与网络状态，或稍后重试。'));
      }
    });
    request.end();
  });
}

export async function fetchPublicHtml(input: string, options: FetchPublicHtmlOptions = {}): Promise<FetchedPage> {
  const requested = parsePublicHttpUrl(input);
  let current = requested;

  for (let redirectCount = 0; redirectCount <= FETCH_LIMITS.maxRedirects; redirectCount += 1) {
    parsePublicHttpUrl(current.toString());
    const addresses = await resolvePublicAddresses(current.hostname);
    const { status, headers, body } = await singleRequest(current, addresses[0].address, addresses[0].family);

    if ([301, 302, 303, 307, 308].includes(status)) {
      if (redirectCount === FETCH_LIMITS.maxRedirects) {
        throw new FetchPolicyError('TOO_MANY_REDIRECTS', '网页重定向次数过多。', '请使用页面最终公开地址。');
      }
      const next = validateRedirect(headers.location, current);
      await options.beforeRedirect?.(next, current);
      current = next;
      continue;
    }

    const contentType = validateHtmlResponse(status, headers);

    return {
      requestedUrl: requested.toString(),
      finalUrl: current.toString(),
      status,
      contentType,
      contentLength: body.length,
      html: body.toString('utf8'),
      fetchedAt: new Date().toISOString()
    };
  }
  throw new FetchPolicyError('TOO_MANY_REDIRECTS', '网页重定向次数过多。', '请使用页面最终公开地址。');
}
