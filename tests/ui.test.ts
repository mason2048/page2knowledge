// @vitest-environment jsdom

import fs from 'node:fs/promises';
import path from 'node:path';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.js';

describe('基础 UI 逻辑与键盘契约', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      status: 'ok',
      version: '0.2.1',
      authRequired: false
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('来源 tabs 支持方向键、Home/End，并同步切换可见工作流', async () => {
    render(createElement(App));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/health'));

    const urlTab = screen.getByRole('tab', { name: '单页 URL' });
    const fileTab = screen.getByRole('tab', { name: '本地文件' });
    const siteTab = screen.getByRole('tab', { name: '站点范围' });
    expect(urlTab).toHaveAttribute('aria-selected', 'true');

    urlTab.focus();
    fireEvent.keyDown(urlTab, { key: 'ArrowRight' });
    expect(fileTab).toHaveFocus();
    expect(fileTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: /选择 PDF、转录或音视频文件/ })).toBeVisible();

    fireEvent.keyDown(fileTab, { key: 'End' });
    expect(siteTab).toHaveFocus();
    expect(siteTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: '开始有限爬取' })).toBeVisible();

    fireEvent.keyDown(siteTab, { key: 'Home' });
    expect(urlTab).toHaveFocus();
    expect(urlTab).toHaveAttribute('aria-selected', 'true');
  });

  it('产品工作区使用原生按钮，可聚焦并激活对应内容', () => {
    render(createElement(App));
    const diffButton = screen.getByRole('button', { name: '差异' });
    diffButton.focus();
    expect(diffButton).toHaveFocus();
    fireEvent.click(diffButton);
    expect(screen.getByRole('heading', { name: '版本差异' })).toBeVisible();
  });

  it('本地 PDF 转换结果可从界面送入知识库索引', async () => {
    const localResult = {
      schemaVersion: '0.1',
      packageId: 'local-package',
      name: 'local-guide',
      sourceKind: 'pdf',
      snapshot: {
        requestedUrl: 'file:///local-guide.pdf',
        finalUrl: 'file:///local-guide.pdf',
        fetchedAt: '2026-08-12T12:00:00.000Z',
        status: 200,
        contentType: 'application/pdf',
        contentLength: 128,
        contentHash: `sha256:${'a'.repeat(64)}`,
        title: '本地 PDF 指南',
        author: null,
        publishedAt: null,
        updatedAt: null
      },
      markdown: '# 本地 PDF 指南\n\n本地内容可以安全索引。',
      summary: '本地内容可以安全索引。',
      keyFacts: [],
      chunks: [{
        id: 'local-chunk',
        title: '本地 PDF 指南',
        titlePath: ['本地 PDF 指南'],
        markdown: '# 本地 PDF 指南\n\n本地内容可以安全索引。',
        revision: `sha256:${'b'.repeat(64)}`,
        source: { url: 'file:///local-guide.pdf', locator: 'pdf:page=1' }
      }],
      warnings: [],
      contextPackage: {
        schemaVersion: '0.1',
        packageId: 'local-package',
        name: 'local-guide',
        kind: 'mixed',
        createdAt: '2026-08-12T12:00:00.000Z',
        producer: { name: 'page2knowledge', version: '0.2.1' },
        items: [],
        warnings: []
      }
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const payload = url === '/api/health'
        ? { status: 'ok', version: '0.2.1', authRequired: false }
        : url === '/api/ingest'
          ? localResult
          : url === '/api/knowledge/stats'
            ? { chunkCount: 0 }
            : url === '/api/knowledge/index'
              ? { documentCount: 1, chunkCount: 1 }
              : { error: { code: 'UNEXPECTED_TEST_ROUTE', message: url, suggestion: '' } };
      return new Response(JSON.stringify(payload), {
        status: 'error' in payload ? 500 : 200,
        headers: { 'content-type': 'application/json' }
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(createElement(App));

    fireEvent.click(screen.getByRole('tab', { name: '本地文件' }));
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    fireEvent.change(fileInput!, { target: { files: [new File(['%PDF'], 'local-guide.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => expect(screen.getAllByText('本地 PDF 指南').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: '知识库' }));
    const indexButton = await screen.findByRole('button', { name: /索引当前结果/ });
    expect(indexButton).toBeEnabled();
    fireEvent.click(indexButton);
    await screen.findByText('已索引《本地 PDF 指南》的 1 个区块。');

    const indexCall = fetchMock.mock.calls.find(([input]) => String(input) === '/api/knowledge/index');
    expect(indexCall?.[1]?.method).toBe('POST');
    expect(String(indexCall?.[1]?.body)).toContain('file:///local-guide.pdf');
  });
});

describe('响应式静态契约', () => {
  it('保留 320px 下限和 700px 移动端单列规则', async () => {
    const css = await fs.readFile(path.resolve('src/styles.css'), 'utf8');
    expect(css).toMatch(/body\s*\{[^}]*min-width:\s*320px/s);
    const mobile = css.match(/@media \(max-width:\s*700px\)\s*\{([\s\S]*)\}\s*$/)?.[1] ?? '';
    expect(mobile).toMatch(/\.workspace\s*\{[^}]*flex-direction:\s*column/s);
    expect(mobile).toMatch(/\.export-actions\s*\{[^}]*grid-template-columns:\s*1fr/s);
    expect(mobile).toMatch(/\.knowledge-columns\s*\{[^}]*grid-template-columns:\s*1fr/s);
    expect(mobile).toMatch(/\.schedule-form\s*\{[^}]*grid-template-columns:\s*1fr/s);
  });
});
