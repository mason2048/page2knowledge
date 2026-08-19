import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { toContextPackage, transformHtml } from '../server/transform.js';

const FIXTURE_PATH = path.resolve('samples/technical-document.html');

function terms(value: string): string[] {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .match(/[\p{Script=Han}]|[\p{L}\p{N}_@./:+-]+/gu) ?? [];
}

function counts(values: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

function coverage(expected: string[], actual: string[]): number {
  if (!expected.length) return 1;
  const expectedCounts = counts(expected);
  const actualCounts = counts(actual);
  let matched = 0;
  for (const [term, expectedCount] of expectedCounts) {
    matched += Math.min(expectedCount, actualCounts.get(term) ?? 0);
  }
  return matched / expected.length;
}

export type QualityBaseline = {
  fixture: string;
  expectedBodyTerms: number;
  navigationNoiseTerms: number;
  codeBlocks: number;
  bodyRetentionRate: number;
  navigationNoiseRetentionRate: number;
  codeLanguageRetentionRate: number;
  pipelineDurationMs: number;
};

export async function measureQualityBaseline(): Promise<QualityBaseline> {
  const html = await fs.readFile(FIXTURE_PATH, 'utf8');
  const source = new JSDOM(html).window.document;
  const expectedBody = terms(source.querySelector('article')?.textContent ?? '');
  const expectedBodySet = new Set(expectedBody);
  const navigationNoise = terms(
    [...source.querySelectorAll('nav, body > aside, body > footer')]
      .map((element) => element.textContent ?? '')
      .join('\n')
  ).filter((term) => !expectedBodySet.has(term));
  const expectedLanguages = [...source.querySelectorAll('pre code')]
    .map((code) => code.className.match(/(?:language-|lang-)([\w-]+)/i)?.[1]?.toLowerCase())
    .filter((language): language is string => Boolean(language));

  const startedAt = performance.now();
  const result = transformHtml({
    requestedUrl: 'https://docs.example.com/quickstart',
    finalUrl: 'https://docs.example.com/quickstart',
    status: 200,
    contentType: 'text/html; charset=utf-8',
    contentLength: Buffer.byteLength(html),
    html,
    fetchedAt: '2026-08-12T12:00:00.000Z'
  });
  const contextPackage = toContextPackage(result);
  const pipelineDurationMs = performance.now() - startedAt;
  if (contextPackage.items.length !== result.chunks.length + result.keyFacts.length) {
    throw new Error('固定夹具未完整生成 Context Package。');
  }
  const actualTerms = terms(result.markdown);
  const retainedLanguages = expectedLanguages.filter((language) => (
    new RegExp('(^|\\n)\\s*```' + language + '(?:\\s|$)', 'i').test(result.markdown)
  ));

  return {
    fixture: path.relative(process.cwd(), FIXTURE_PATH),
    expectedBodyTerms: expectedBody.length,
    navigationNoiseTerms: navigationNoise.length,
    codeBlocks: expectedLanguages.length,
    bodyRetentionRate: coverage(expectedBody, actualTerms),
    navigationNoiseRetentionRate: coverage(navigationNoise, actualTerms),
    codeLanguageRetentionRate: expectedLanguages.length ? retainedLanguages.length / expectedLanguages.length : 1,
    pipelineDurationMs
  };
}

export function assertQualityBaseline(metrics: QualityBaseline): void {
  if (metrics.expectedBodyTerms === 0) throw new Error('质量夹具没有正文词元。');
  if (metrics.navigationNoiseTerms === 0) throw new Error('质量夹具没有可测量的导航噪声词元。');
  if (metrics.codeBlocks === 0) throw new Error('质量夹具没有带语言标识的代码块。');
  if (metrics.bodyRetentionRate < 0.9) throw new Error(`正文保留率 ${(metrics.bodyRetentionRate * 100).toFixed(2)}% 低于 90%。`);
  if (metrics.navigationNoiseRetentionRate > 0.1) throw new Error(`导航噪声保留率 ${(metrics.navigationNoiseRetentionRate * 100).toFixed(2)}% 高于 10%。`);
  if (metrics.codeLanguageRetentionRate < 0.95) throw new Error(`代码语言保留率 ${(metrics.codeLanguageRetentionRate * 100).toFixed(2)}% 低于 95%。`);
  if (metrics.pipelineDurationMs > 60_000) throw new Error(`固定夹具从输入到 Context Package 的耗时 ${metrics.pipelineDurationMs.toFixed(2)}ms 超过 60 秒。`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const metrics = await measureQualityBaseline();
  assertQualityBaseline(metrics);
  process.stdout.write(`${JSON.stringify({
    ...metrics,
    bodyRetentionPercent: Number((metrics.bodyRetentionRate * 100).toFixed(2)),
    navigationNoiseRetentionPercent: Number((metrics.navigationNoiseRetentionRate * 100).toFixed(2)),
    codeLanguageRetentionPercent: Number((metrics.codeLanguageRetentionRate * 100).toFixed(2)),
    pipelineDurationMs: Number(metrics.pipelineDurationMs.toFixed(2))
  }, null, 2)}\n`);
}
