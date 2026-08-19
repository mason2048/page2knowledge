import { describe, expect, it } from 'vitest';
import { assertQualityBaseline, measureQualityBaseline } from '../scripts/quality-baseline.js';

describe('PRD 固定夹具质量基准', () => {
  it('正文、导航噪声、代码语言和 60 秒门槛可重复测量', async () => {
    const metrics = await measureQualityBaseline();
    expect(() => assertQualityBaseline(metrics)).not.toThrow();
    expect(metrics.bodyRetentionRate).toBeGreaterThanOrEqual(0.9);
    expect(metrics.navigationNoiseRetentionRate).toBeLessThanOrEqual(0.1);
    expect(metrics.codeLanguageRetentionRate).toBeGreaterThanOrEqual(0.95);
    expect(metrics.pipelineDurationMs).toBeLessThanOrEqual(60_000);
  });
});
