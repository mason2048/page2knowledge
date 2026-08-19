import { describe, expect, it, vi } from 'vitest';
import { isPublicAddress, parsePublicHttpUrl, resolvePublicAddresses } from '../server/security.js';
import { validateHtmlResponse, validateRedirect } from '../server/fetcher.js';

describe('公开 URL 安全策略', () => {
  it.each([
    'http://localhost/admin',
    'http://127.0.0.1/',
    'http://10.0.0.8/',
    'http://172.16.1.2/',
    'http://192.168.1.5/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'file:///etc/passwd',
    'ftp://example.com/file'
  ])('阻断 %s', (url) => {
    expect(() => parsePublicHttpUrl(url)).toThrow();
  });

  it('允许无凭据的公网 HTTP/HTTPS URL', () => {
    expect(parsePublicHttpUrl('https://example.com/docs').hostname).toBe('example.com');
    expect(parsePublicHttpUrl('http://8.8.8.8/').hostname).toBe('8.8.8.8');
  });

  it('阻断解析到任意私有地址的域名，防止 DNS rebinding', async () => {
    const resolver = vi.fn().mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 }
    ]);
    await expect(resolvePublicAddresses('example.com', resolver)).rejects.toMatchObject({ code: 'PRIVATE_ADDRESS_BLOCKED' });
  });

  it.each([
    ['8.8.8.8', true],
    ['127.0.0.1', false],
    ['10.0.0.1', false],
    ['169.254.169.254', false],
    ['::1', false],
    ['fc00::1', false]
  ])('正确分类 %s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });

  it('重定向到内网地址时仍然阻断', () => {
    expect(() => validateRedirect('http://169.254.169.254/latest/meta-data/', new URL('https://example.com/start'))).toThrowError(/已阻止/);
    expect(() => validateRedirect('/public-page', new URL('https://example.com/start'))).not.toThrow();
  });

  it('非 HTML、超大响应和 HTTP 错误具有独立失败原因', () => {
    expect(() => validateHtmlResponse(200, { 'content-type': 'application/pdf' })).toThrowError(/不支持的内容类型/);
    expect(() => validateHtmlResponse(200, { 'content-type': 'text/html', 'content-length': String(3 * 1024 * 1024) })).toThrowError(/超过 2 MB/);
    expect(() => validateHtmlResponse(503, { 'content-type': 'text/html' })).toThrowError(/HTTP 503/);
  });
});
