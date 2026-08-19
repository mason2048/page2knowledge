import type { NextFunction, Request, Response } from 'express';
import ipaddr from 'ipaddr.js';

const DEFAULT_APPLICATION_PORT = 4315;
const SAFE_BROWSERLESS_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

type Authority = {
  canonical: string;
  hostname: string;
  port: number | null;
};

type ParsedOrigin = {
  compatibleAuthorities: Set<string>;
  canonical: string;
  protocol: 'http:' | 'https:';
};

type RequestOriginPolicy = {
  applicationPort: number;
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
};

function policyError(response: Response, status: number, code: string, message: string, suggestion: string): void {
  response.status(status).json({ error: { code, message, suggestion } });
}

function parsePort(value: string): number {
  if (!/^\d{1,5}$/.test(value)) throw new Error('端口必须是 1–65535 的十进制整数。');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('端口必须是 1–65535 的十进制整数。');
  if (value !== String(port)) throw new Error('端口必须使用不带前导零的规范十进制格式。');
  return port;
}

function parseAuthority(value: string): Authority {
  if (!value || value !== value.trim() || value.length > 512 || /[\u0000-\u0020\u007f,/@\\?#]/.test(value)) {
    throw new Error('Host 必须是单个无凭据、无路径的主机与可选端口。');
  }

  if (value.startsWith('[')) {
    const match = value.match(/^\[([0-9A-Fa-f:.]+)\](?::(\d{1,5}))?$/);
    if (!match) throw new Error('IPv6 Host 必须使用方括号并可附带有效端口。');
    const parsed = ipaddr.parse(match[1]);
    if (parsed.kind() !== 'ipv6') throw new Error('方括号 Host 必须是 IPv6 地址。');
    const hostname = parsed.toString().toLowerCase();
    const port = match[2] ? parsePort(match[2]) : null;
    const canonical = `[${hostname}]${port === null ? '' : `:${port}`}`;
    if (value.toLowerCase() !== canonical) throw new Error('Host 必须使用规范地址和端口格式。');
    return { hostname, port, canonical };
  }

  if (value.includes('[') || value.includes(']') || (value.match(/:/g)?.length ?? 0) > 1) {
    throw new Error('IPv6 Host 必须使用方括号。');
  }
  const separator = value.lastIndexOf(':');
  const rawHostname = (separator < 0 ? value : value.slice(0, separator)).toLowerCase();
  const port = separator < 0 ? null : parsePort(value.slice(separator + 1));
  if (!rawHostname || rawHostname.endsWith('.')) throw new Error('Host 主机名不能为空或以点结尾。');

  let hostname = rawHostname;
  if (ipaddr.isValid(rawHostname)) {
    const parsed = ipaddr.parse(rawHostname);
    if (parsed.kind() !== 'ipv4') throw new Error('IPv6 Host 必须使用方括号。');
    hostname = parsed.toString();
  } else if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(rawHostname)) {
    throw new Error('Host 主机名格式无效。');
  }
  const canonical = `${hostname}${port === null ? '' : `:${port}`}`;
  if (value.toLowerCase() !== canonical) throw new Error('Host 必须使用规范地址和端口格式。');
  return { hostname, port, canonical };
}

function parseOrigin(value: string): ParsedOrigin {
  if (!value || value !== value.trim() || value.toLowerCase() === 'null' || value.includes(',')) {
    throw new Error('Origin 必须是单个明确的 HTTP/HTTPS 来源。');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Origin 格式无效。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Origin 必须只包含 HTTP/HTTPS 协议、主机和可选端口。');
  }
  const authority = parseAuthority(url.host);
  const protocol = url.protocol as 'http:' | 'https:';
  const canonical = `${protocol}//${authority.canonical}`;
  const defaultPort = protocol === 'https:' ? 443 : 80;
  const acceptedWireValues = new Set([canonical]);
  const compatibleAuthorities = new Set([authority.canonical]);
  if (authority.port === null) {
    acceptedWireValues.add(`${canonical}:${defaultPort}`);
    compatibleAuthorities.add(`${authority.canonical}:${defaultPort}`);
  }
  if (!acceptedWireValues.has(value.toLowerCase())) {
    throw new Error('Origin 必须使用规范格式且不能包含路径或非规范端口。');
  }
  return { compatibleAuthorities, canonical, protocol };
}

function configuredApplicationPort(): number {
  const raw = process.env.PAGE2KNOWLEDGE_PORT?.trim();
  if (!raw) return DEFAULT_APPLICATION_PORT;
  try {
    return parsePort(raw);
  } catch (error) {
    throw new Error(`PAGE2KNOWLEDGE_PORT 无效：${error instanceof Error ? error.message : '格式错误'}`);
  }
}

function splitConfiguration(name: string): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return [];
  const values = raw.split(',').map((item) => item.trim());
  if (values.some((item) => !item)) throw new Error(`${name} 不能包含空条目。`);
  return values;
}

function createPolicy(): RequestOriginPolicy {
  const applicationPort = configuredApplicationPort();
  const allowedHosts = new Set<string>();
  for (const value of splitConfiguration('PAGE2KNOWLEDGE_ALLOWED_HOSTS')) {
    try {
      allowedHosts.add(parseAuthority(value).canonical);
    } catch (error) {
      throw new Error(`PAGE2KNOWLEDGE_ALLOWED_HOSTS 包含无效条目 ${JSON.stringify(value)}：${error instanceof Error ? error.message : '格式错误'}`);
    }
  }
  const allowedOrigins = new Set<string>();
  for (const value of splitConfiguration('PAGE2KNOWLEDGE_ALLOWED_ORIGINS')) {
    try {
      allowedOrigins.add(parseOrigin(value).canonical);
    } catch (error) {
      throw new Error(`PAGE2KNOWLEDGE_ALLOWED_ORIGINS 包含无效条目 ${JSON.stringify(value)}：${error instanceof Error ? error.message : '格式错误'}`);
    }
  }
  return { applicationPort, allowedHosts, allowedOrigins };
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  if (!ipaddr.isValid(hostname)) return false;
  return ipaddr.parse(hostname).range() === 'loopback';
}

function isAllowedHost(authority: Authority, policy: RequestOriginPolicy, protocol: 'http:' | 'https:'): boolean {
  if (policy.allowedHosts.has(authority.canonical)) return true;
  if (!isLoopbackHostname(authority.hostname)) return false;
  if (authority.port === policy.applicationPort) return true;
  return authority.port === null
    && ((protocol === 'http:' && policy.applicationPort === 80) || (protocol === 'https:' && policy.applicationPort === 443));
}

function directProtocol(request: Request): 'http:' | 'https:' {
  // `trust proxy` is disabled by createApp, so this reflects the direct socket
  // and never X-Forwarded-Proto / Forwarded supplied by a client.
  return request.protocol === 'https' ? 'https:' : 'http:';
}

export function createRequestOriginGuard() {
  const policy = createPolicy();
  return (request: Request, response: Response, next: NextFunction): void => {
    // The app has no implicit trusted-proxy mode. Remove client-supplied proxy
    // metadata before rate limiting and later middleware so it cannot affect
    // identity, scheme or authority anywhere in this process.
    delete request.headers.forwarded;
    delete request.headers['x-forwarded-for'];
    delete request.headers['x-forwarded-host'];
    delete request.headers['x-forwarded-port'];
    delete request.headers['x-forwarded-proto'];

    const rawHost = request.headers.host;
    if (typeof rawHost !== 'string') {
      policyError(response, 400, 'HOST_HEADER_REQUIRED', '请求缺少有效 Host 请求头。', '请使用应用实际监听的本机地址和端口。');
      return;
    }

    let host: Authority;
    try {
      host = parseAuthority(rawHost);
    } catch {
      policyError(response, 400, 'INVALID_HOST_HEADER', 'Host 请求头格式无效。', '请只发送一个规范主机名或方括号 IPv6 地址及应用端口。');
      return;
    }

    const protocol = directProtocol(request);
    if (!isAllowedHost(host, policy, protocol)) {
      policyError(response, 403, 'HOST_NOT_ALLOWED', '请求 Host 不在本应用允许范围内。', '本地模式只接受 loopback/localhost 与配置端口；反向代理域名必须显式加入允许列表。');
      return;
    }

    const rawOrigin = request.headers.origin;
    const fetchSite = request.headers['sec-fetch-site'];
    if (rawOrigin === undefined) {
      if (fetchSite !== undefined) {
        const site = typeof fetchSite === 'string' ? fetchSite.toLowerCase() : '';
        const safeNavigation = site === 'none' && SAFE_BROWSERLESS_METHODS.has(request.method.toUpperCase());
        if (site !== 'same-origin' && !safeNavigation) {
          policyError(response, 403, 'ORIGIN_REQUIRED', '浏览器跨来源请求必须提供并通过 Origin 校验。', '请从应用同源页面发起请求；非浏览器客户端不要伪造 Sec-Fetch-* 请求头。');
          return;
        }
      }
      next();
      return;
    }

    if (typeof rawOrigin !== 'string') {
      policyError(response, 403, 'ORIGIN_NOT_ALLOWED', '请求 Origin 无效。', '请从应用同源页面发起请求。');
      return;
    }
    let origin: ParsedOrigin;
    try {
      origin = parseOrigin(rawOrigin);
    } catch {
      policyError(response, 403, 'ORIGIN_NOT_ALLOWED', '请求 Origin 无效或不受信任。', '不接受 null、多值、含路径或非 HTTP/HTTPS Origin。');
      return;
    }

    const sameAuthority = origin.compatibleAuthorities.has(host.canonical);
    const sameDirectOrigin = sameAuthority && origin.protocol === protocol;
    const explicitlyAllowedProxyOrigin = sameAuthority && policy.allowedOrigins.has(origin.canonical);
    if (!sameDirectOrigin && !explicitlyAllowedProxyOrigin) {
      policyError(response, 403, 'ORIGIN_NOT_ALLOWED', '请求 Origin 与应用来源不一致。', '请从同源页面发起请求；TLS 反向代理来源必须显式加入允许列表。');
      return;
    }
    if (fetchSite !== undefined && (typeof fetchSite !== 'string' || fetchSite.toLowerCase() !== 'same-origin')) {
      policyError(response, 403, 'FETCH_METADATA_MISMATCH', '浏览器来源元数据与已校验 Origin 不一致。', '请从应用同源页面发起请求。');
      return;
    }
    next();
  };
}
