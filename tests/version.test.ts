import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { crawlerUserAgent, PRODUCT_NAME, PRODUCT_VERSION, SINGLE_PAGE_USER_AGENT } from '../shared/version.js';

describe('产品版本身份', () => {
  it('producer 与抓取 User-Agent 都跟随 package 版本', async () => {
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8')) as { name: string; version: string };
    expect(PRODUCT_NAME).toBe(packageJson.name);
    expect(PRODUCT_VERSION).toBe(packageJson.version);
    expect(SINGLE_PAGE_USER_AGENT).toContain(`/${packageJson.version} `);
    expect(crawlerUserAgent('Page2Knowledge')).toContain(`/${packageJson.version} `);
    expect(SINGLE_PAGE_USER_AGENT).not.toContain('/0.1 ');
    expect(crawlerUserAgent('Page2Knowledge')).not.toContain('/0.1 ');
  });
});
