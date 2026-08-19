import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';

const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.google',
  'instance-data.ec2.internal'
]);

export class FetchPolicyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly suggestion: string
  ) {
    super(message);
    this.name = 'FetchPolicyError';
  }
}

export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    const normalized = parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()
      ? (parsed as ipaddr.IPv6).toIPv4Address()
      : parsed;
    return normalized.range() === 'unicast';
  } catch {
    return false;
  }
}

export function parsePublicHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new FetchPolicyError('INVALID_URL', '请输入完整的 HTTP 或 HTTPS 地址。', '示例：https://developer.mozilla.org/');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new FetchPolicyError('UNSUPPORTED_PROTOCOL', '只允许公开 HTTP/HTTPS 网页。', '请使用以 http:// 或 https:// 开头的地址。');
  }
  if (url.username || url.password) {
    throw new FetchPolicyError('URL_CREDENTIALS_BLOCKED', 'URL 中不能包含用户名或密码。', '请移除地址中的凭据。');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new FetchPolicyError('PRIVATE_ADDRESS_BLOCKED', '已阻止本机或内网地址。', '请改用无需登录即可访问的公开网页。');
  }
  if (ipaddr.isValid(hostname) && !isPublicAddress(hostname)) {
    throw new FetchPolicyError('PRIVATE_ADDRESS_BLOCKED', '已阻止本机、私有、链路本地或保留地址。', '请改用公网 HTTP/HTTPS 地址。');
  }
  return url;
}

export async function resolvePublicAddresses(
  hostname: string,
  resolver: typeof dns.lookup = dns.lookup
): Promise<Array<{ address: string; family: number }>> {
  hostname = hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(hostname)) {
    if (!isPublicAddress(hostname)) {
      throw new FetchPolicyError('PRIVATE_ADDRESS_BLOCKED', '目标地址不是公网地址。', '请使用公开网页。');
    }
    return [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv6' ? 6 : 4 }];
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await resolver(hostname, { all: true, verbatim: true });
  } catch {
    throw new FetchPolicyError('DNS_FAILED', '无法解析目标域名。', '请检查地址拼写、网络连接或稍后重试。');
  }
  if (!records.length || records.some((record) => !isPublicAddress(record.address))) {
    throw new FetchPolicyError('PRIVATE_ADDRESS_BLOCKED', '域名解析到了本机、内网或保留地址。', '请使用解析到公网地址的公开网页。');
  }
  return records;
}
