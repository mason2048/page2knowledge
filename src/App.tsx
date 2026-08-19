import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  AlertTriangle,
  BookOpenText,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  Code2,
  Copy,
  Database,
  ExternalLink,
  FileJson2,
  FileText,
  FileUp,
  Fingerprint,
  Globe2,
  GitCompareArrows,
  Link2,
  LoaderCircle,
  CalendarClock,
  KeyRound,
  Pencil,
  Play,
  RotateCcw,
  ShieldCheck
} from 'lucide-react';
import type { ApiError, ContextPackage, KnowledgeChunk, KnowledgeResult } from '../shared/types';
import { ApiClientError, apiRequest, getAccessToken, postJson, setAccessToken } from './api';
import { VersionWorkspace } from './components/VersionWorkspace';
import { KnowledgeWorkspace } from './components/KnowledgeWorkspace';
import { ScheduleWorkspace } from './components/ScheduleWorkspace';

type ExtractResponse = KnowledgeResult & { contextPackage: ContextPackage };
type ActiveView = 'markdown' | 'facts' | 'page';
type WorkspaceMode = 'convert' | 'versions' | 'knowledge' | 'schedules';
type SourceMode = 'url' | 'file' | 'site';

const DEFAULT_URL = 'https://developer.mozilla.org/zh-CN/docs/Web/HTTP/Status/200';
const SOURCE_MODES = ['url', 'file', 'site'] as const satisfies readonly SourceMode[];
const RESULT_VIEWS = ['markdown', 'facts', 'page'] as const satisfies readonly ActiveView[];

const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
const formatDate = (value: string | null) => value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '未提供';

function handleTabKey<T extends string>(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  values: readonly T[],
  current: T,
  select: (value: T) => void
) {
  const currentIndex = values.indexOf(current);
  let nextIndex = currentIndex;
  if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % values.length;
  else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + values.length) % values.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = values.length - 1;
  else return;

  event.preventDefault();
  select(values[nextIndex]);
  const tabs = event.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  tabs?.[nextIndex]?.focus();
}

function download(name: string, content: string, type: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

function MetadataStrip({ result }: { result: ExtractResponse }) {
  const items = [
    { icon: Globe2, label: '最终 URL', value: result.snapshot.finalUrl, className: 'url-value' },
    { icon: Clock3, label: '抓取时间', value: formatDate(result.snapshot.fetchedAt) },
    { icon: Code2, label: 'HTTP 状态', value: `${result.snapshot.status} OK`, className: 'success-text' },
    { icon: FileText, label: '内容类型', value: result.snapshot.contentType.split(';')[0] },
    { icon: Fingerprint, label: '内容哈希', value: result.snapshot.contentHash.replace('sha256:', '').slice(0, 18) + '…' }
  ];
  return <section className="metadata-strip" aria-label="抓取元数据">
    {items.map(({ icon: Icon, label, value, className }) => <div className="metadata-item" key={label}>
      <Icon size={19} strokeWidth={1.8} aria-hidden="true" />
      <div><span>{label}</span><strong className={className} title={value}>{value}</strong></div>
    </div>)}
  </section>;
}

function PageInfo({ result }: { result: ExtractResponse }) {
  return <aside className="page-info">
    <h2>页面信息</h2>
    <dl>
      <div><dt>标题</dt><dd>{result.snapshot.title}</dd></div>
      <div><dt>作者</dt><dd>{result.snapshot.author ?? '未提供'}</dd></div>
      <div><dt>发布时间</dt><dd>{formatDate(result.snapshot.publishedAt)}</dd></div>
      <div><dt>更新时间</dt><dd>{formatDate(result.snapshot.updatedAt)}</dd></div>
      <div><dt>正文大小</dt><dd>{formatBytes(result.snapshot.contentLength)}</dd></div>
      <div><dt>知识块</dt><dd>{result.chunks.length} 个</dd></div>
      <div><dt>已确认事实</dt><dd>{result.keyFacts.length} 条</dd></div>
    </dl>
    <div className="cleaning-note">
      <ShieldCheck size={18} aria-hidden="true" />
      <div><strong>安全清理已完成</strong><p>脚本、表单、嵌入内容和页面模板噪声不会进入知识包。</p></div>
    </div>
    <div className="copyright-note">内容版权仍归原权利人所有。此工具只保存公开页面的本地转换结果。</div>
  </aside>;
}

function MarkdownViewer({ markdown }: { markdown: string }) {
  return <div className="markdown-viewer" aria-label="清理后 Markdown">
    <div className="line-numbers" aria-hidden="true">{markdown.split('\n').map((_, index) => <span key={index}>{index + 1}</span>)}</div>
    <pre>{markdown}</pre>
  </div>;
}

function FactsViewer({ result }: { result: ExtractResponse }) {
  return <div className="facts-viewer">
    <div className="summary-block"><span>未验证摘录摘要</span><p>{result.summary}</p></div>
    <h3>已确认事实</h3>
    {result.keyFacts.length ? result.keyFacts.map((fact) => <article className="fact-row" key={fact.id}>
      <Check size={17} aria-hidden="true" />
      <div><p>{fact.statement}</p><small>{fact.source.titlePath.join(' / ')} · {fact.source.locator}</small></div>
    </article>) : <p className="empty-state">默认不自动升格事实；正文仅作为带来源的引用，需可信来源逐条确认后才能生成 fact。</p>}
  </div>;
}

function ChunkList({ chunks, excluded, onToggle, onEdit }: { chunks: KnowledgeChunk[]; excluded: Set<string>; onToggle: (id: string) => void; onEdit: (id: string, title: string) => Promise<boolean> }) {
  const [openId, setOpenId] = useState(chunks[0]?.id ?? '');
  const [editingId, setEditingId] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  return <section className="chunk-panel">
    <div className="chunk-heading"><div><span>知识块</span><strong>{chunks.length}</strong></div><small>每块均含来源与版本</small></div>
    <div className="chunk-list">
      {chunks.map((chunk, index) => {
        const open = openId === chunk.id;
        return <article className={`chunk ${open ? 'open' : ''} ${excluded.has(chunk.id) ? 'excluded' : ''}`} key={chunk.id}>
          <button className="chunk-toggle" onClick={() => setOpenId(open ? '' : chunk.id)} aria-expanded={open}>
            <span className="chunk-index">{String(index + 1).padStart(2, '0')}</span>
            <span className="chunk-title">{chunk.title}</span>
            <span className="revision">{chunk.revision.slice(7, 15)}</span>
            {open ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
          </button>
          {open && <div className="chunk-body">
            <label className="exclude-control"><input type="checkbox" checked={excluded.has(chunk.id)} onChange={() => onToggle(chunk.id)} /><span>从后续导出中排除此区块</span></label>
            <div className="title-editor"><span>标题路径</span>{editingId === chunk.id ? <form onSubmit={(event) => { event.preventDefault(); void onEdit(chunk.id, draftTitle).then((saved) => { if (saved) setEditingId(''); }); }}><input aria-label="知识块新标题" maxLength={160} value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} autoFocus /><button>保存并重建</button><button type="button" onClick={() => setEditingId('')}>取消</button></form> : <p>{chunk.titlePath.join(' / ')} <button aria-label={`编辑 ${chunk.title} 标题`} onClick={() => { setEditingId(chunk.id); setDraftTitle(chunk.title); }}><Pencil size={12} />编辑</button></p>}</div>
            <div><span>来源定位</span><p>{chunk.source.locator}</p></div>
            <div><span>内容 revision</span><code>{chunk.revision}</code></div>
            <p className="chunk-preview">{chunk.markdown.replace(/^#+\s+/gm, '').slice(0, 260)}</p>
            <a href={chunk.source.url} target="_blank" rel="noreferrer">打开原网页 <ExternalLink size={13} /></a>
          </div>}
        </article>;
      })}
    </div>
  </section>;
}

function ExportBar({ result, excluded, onError }: { result: ExtractResponse; excluded: Set<string>; onError: (error: ApiError['error']) => void }) {
  const base = result.name || 'page2knowledge';
  async function filtered(): Promise<ExtractResponse> {
    if (!excluded.size) return result;
    if (excluded.size >= result.chunks.length) {
      throw new ApiClientError(
        '不能排除全部知识块；请至少保留一个区块后再导出。',
        'ALL_CHUNKS_EXCLUDED',
        '请取消至少一个区块的排除后重试。',
        400
      );
    }
    const output = await postJson<{ result: KnowledgeResult; contextPackage: ContextPackage }>('/api/exports/filter', { result, excludedChunkIds: [...excluded] });
    return { ...output.result, contextPackage: output.contextPackage };
  }
  async function exportAs(kind: 'markdown' | 'json' | 'context') {
    try {
      const next = await filtered();
      if (kind === 'markdown') download(`${base}.md`, next.markdown, 'text/markdown;charset=utf-8');
      if (kind === 'json') download(`${base}.json`, JSON.stringify(next, null, 2), 'application/json');
      if (kind === 'context') download(`${base}.context.json`, JSON.stringify(next.contextPackage, null, 2), 'application/json');
    } catch (cause) {
      onError({
        code: cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : 'EXPORT_FAILED',
        message: cause instanceof Error ? cause.message : '知识包导出失败。',
        suggestion: '请至少保留一个知识块，并检查本地服务状态后重试。'
      });
    }
  }
  const allExcluded = excluded.size >= result.chunks.length;
  return <section className="export-bar">
    <div><h2>导出知识包</h2><p>{allExcluded ? '已排除全部区块；请至少恢复一个区块后再导出。' : excluded.size ? `将排除 ${excluded.size} 个区块并重建摘要、来源引用与哈希。` : '所有文件仅由当前浏览器保存到你选择的位置。'}</p></div>
    <div className="export-actions">
      <button disabled={allExcluded} onClick={() => void exportAs('markdown')}><FileText size={20} /> <span>Markdown<small>.md</small></span></button>
      <button disabled={allExcluded} onClick={() => void exportAs('json')}><FileJson2 size={20} /> <span>结构化 JSON<small>.json</small></span></button>
      <button disabled={allExcluded} className="primary-export" onClick={() => void exportAs('context')}><Braces size={20} /> <span>Context Package<small>v0.1 JSON</small></span></button>
    </div>
  </section>;
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceMode>('convert');
  const [sourceMode, setSourceMode] = useState<SourceMode>('url');
  const [url, setUrl] = useState(DEFAULT_URL);
  const [result, setResult] = useState<ExtractResponse | null>(null);
  const [error, setError] = useState<ApiError['error'] | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<ActiveView>('markdown');
  const [copied, setCopied] = useState(false);
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set());
  const [authRequired, setAuthRequired] = useState(false);
  const [token, setToken] = useState(() => getAccessToken());
  const [crawlPages, setCrawlPages] = useState(10);
  const [crawlDepth, setCrawlDepth] = useState(2);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void fetch('/api/health').then((response) => response.json()).then((health: { authRequired?: boolean }) => setAuthRequired(Boolean(health.authRequired))).catch(() => undefined);
  }, []);

  async function load(endpoint: string, body?: { url: string }) {
    setLoading(true);
    setError(null);
    try {
      const data = await apiRequest<ExtractResponse>(endpoint, body ? { method: 'POST', body: JSON.stringify(body) } : undefined);
      setResult(data);
      setExcluded(new Set());
      setView('markdown');
    } catch (cause) {
      setError(cause && typeof cause === 'object' && 'message' in cause ? cause as ApiError['error'] : { code: 'NETWORK_ERROR', message: '无法连接本地服务。', suggestion: '请确认本地服务已启动后重试。' });
    } finally {
      setLoading(false);
    }
  }

  async function ingest(file: File) {
    setLoading(true);
    setError(null);
    try {
      const form = new FormData();
      form.set('file', file);
      if (/^(audio|video)\//.test(file.type) || /\.(mp3|mp4|m4a|wav|webm|mov|mkv|ogg|opus|flac)$/i.test(file.name)) form.set('transcribe', 'true');
      const data = await apiRequest<ExtractResponse>('/api/ingest', { method: 'POST', body: form });
      setResult(data);
      setExcluded(new Set());
      setView('markdown');
    } catch (cause) {
      setError({ code: 'INGEST_FAILED', message: cause instanceof Error ? cause.message : '文件导入失败。', suggestion: '请检查文件类型、大小和本地解析工具。' });
    } finally { setLoading(false); }
  }

  async function crawl() {
    setLoading(true);
    setError(null);
    try {
      const data = await postJson<{ combined: ExtractResponse | null; pages: unknown[]; skipped: unknown[] }>('/api/crawl', { url, maxPages: crawlPages, maxDepth: crawlDepth });
      if (!data.combined) throw new Error('在设定范围内没有提取到可用页面。');
      setResult(data.combined);
      setExcluded(new Set());
      setView('markdown');
    } catch (cause) {
      setError({ code: 'CRAWL_FAILED', message: cause instanceof Error ? cause.message : '站点爬取失败。', suggestion: '请检查 robots.txt、页面范围与公开访问状态。' });
    } finally { setLoading(false); }
  }

  function toggleExcluded(id: string) {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function editChunkTitle(id: string, title: string): Promise<boolean> {
    if (!result) return false;
    try {
      const output = await postJson<{ result: KnowledgeResult; contextPackage: ContextPackage; previousChunkId: string; chunkId: string }>('/api/exports/edit-title', { result, chunkId: id, title });
      setResult({ ...output.result, contextPackage: output.contextPackage });
      setExcluded((current) => {
        if (!current.has(output.previousChunkId)) return current;
        const next = new Set(current);
        next.delete(output.previousChunkId);
        next.add(output.chunkId);
        return next;
      });
      setError(null);
      return true;
    } catch (cause) {
      setError({
        code: cause && typeof cause === 'object' && 'code' in cause ? String(cause.code) : 'TITLE_EDIT_FAILED',
        message: cause instanceof Error ? cause.message : '标题更新失败。',
        suggestion: '请输入 1 到 160 个字符的单行标题后重试。'
      });
      return false;
    }
  }

  async function copyMarkdown() {
    if (!result) return;
    await navigator.clipboard.writeText(result.markdown);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><BookOpenText size={25} strokeWidth={2.2} /><span>Page2Knowledge</span></div>
      <nav className="product-nav" aria-label="产品工作区">
        <button className={workspace === 'convert' ? 'active' : ''} onClick={() => setWorkspace('convert')}><BookOpenText size={15} />转换</button>
        <button className={workspace === 'versions' ? 'active' : ''} onClick={() => setWorkspace('versions')}><GitCompareArrows size={15} />差异</button>
        <button className={workspace === 'knowledge' ? 'active' : ''} onClick={() => setWorkspace('knowledge')}><Database size={15} />知识库</button>
        <button className={workspace === 'schedules' ? 'active' : ''} onClick={() => setWorkspace('schedules')}><CalendarClock size={15} />定时</button>
      </nav>
      <div className="local-note"><span className="local-dot" /> {authRequired ? '受保护服务' : '本地运行'}</div>
      {authRequired ? <label className="token-input"><KeyRound size={15} /><input type="password" aria-label="访问令牌" value={token} onChange={(event) => { setToken(event.target.value); setAccessToken(event.target.value); }} placeholder="当前会话访问令牌" /></label> : <div className="privacy"><ShieldCheck size={17} /> 隐私优先</div>}
    </header>

    <main>
      {workspace === 'versions' ? <VersionWorkspace current={result} /> : null}
      {workspace === 'knowledge' ? <KnowledgeWorkspace current={result} /> : null}
      {workspace === 'schedules' ? <ScheduleWorkspace defaultUrl={result?.snapshot.requestedUrl ?? url} /> : null}
      {workspace === 'convert' ? <>
      <section className="capture-panel">
        <div className="source-switch" role="tablist" aria-label="输入来源">
          <button role="tab" aria-selected={sourceMode === 'url'} tabIndex={sourceMode === 'url' ? 0 : -1} className={sourceMode === 'url' ? 'active' : ''} onClick={() => setSourceMode('url')} onKeyDown={(event) => handleTabKey(event, SOURCE_MODES, sourceMode, setSourceMode)}>单页 URL</button>
          <button role="tab" aria-selected={sourceMode === 'file'} tabIndex={sourceMode === 'file' ? 0 : -1} className={sourceMode === 'file' ? 'active' : ''} onClick={() => setSourceMode('file')} onKeyDown={(event) => handleTabKey(event, SOURCE_MODES, sourceMode, setSourceMode)}>本地文件</button>
          <button role="tab" aria-selected={sourceMode === 'site'} tabIndex={sourceMode === 'site' ? 0 : -1} className={sourceMode === 'site' ? 'active' : ''} onClick={() => setSourceMode('site')} onKeyDown={(event) => handleTabKey(event, SOURCE_MODES, sourceMode, setSourceMode)}>站点范围</button>
        </div>
        {sourceMode === 'file' ? <div className="file-capture"><button onClick={() => fileRef.current?.click()} disabled={loading}><FileUp size={20} />{loading ? '正在本地解析…' : '选择 PDF、转录或音视频文件'}</button><span>PDF ≤ 20 MB；转录 ≤ 5 MB；音视频 ≤ 250 MB，使用本机 Whisper。</span><input ref={fileRef} hidden type="file" accept=".pdf,.vtt,.srt,.txt,audio/*,video/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) void ingest(file); }} /></div> : <form onSubmit={(event) => { event.preventDefault(); if (sourceMode === 'site') void crawl(); else void load('/api/extract', { url }); }}>
          <div className="url-input"><Link2 size={21} aria-hidden="true" /><input aria-label="公开网页 URL" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://公开网页地址" /></div>
          {sourceMode === 'site' ? <div className="crawl-limits"><label>页数<input aria-label="最大页面数" type="number" min={1} max={50} value={crawlPages} onChange={(event) => setCrawlPages(Number(event.target.value))} /></label><label>深度<input aria-label="最大深度" type="number" min={0} max={5} value={crawlDepth} onChange={(event) => setCrawlDepth(Number(event.target.value))} /></label></div> : null}
          <button className="capture-button" disabled={loading}><span>{loading ? <LoaderCircle className="spin" size={19} /> : <Play size={19} fill="currentColor" />}</span>{loading ? '正在安全处理…' : sourceMode === 'site' ? '开始有限爬取' : '生成知识包'}</button>
        </form>}
        <div className="policy"><ShieldCheck size={20} /><span>{sourceMode === 'file' ? '文件在本机内存中解析，不上传外部服务；活动内容不会执行。' : sourceMode === 'site' ? '严格同源、遵守 robots.txt，最多 50 页 / 5 层，逐页执行 SSRF 防护。' : '仅处理公开网页，不登录、不绕过付费墙、不执行网页脚本。'}</span></div>
        {!result && !loading && <button className="example-link" onClick={() => void load('/api/example')}>使用内置技术文档示例</button>}
      </section>

      {error && <section className="error-banner" role="alert">
        <CircleAlert size={22} /><div><strong>{error.message}</strong><p>{error.suggestion}</p></div>
        <button onClick={() => {
          if (sourceMode === 'file') fileRef.current?.click();
          else if (sourceMode === 'site') void crawl();
          else void load('/api/extract', { url });
        }}><RotateCcw size={16} /> {sourceMode === 'file' ? '重新选择' : '重试'}</button>
        <button className="quiet-button" onClick={() => setError(null)}>关闭</button>
      </section>}

      {!result && !error && <section className="welcome-state">
        <div className="welcome-mark"><BookOpenText size={36} /></div>
        <h1>从公开网页得到可追溯的知识</h1>
        <p>保留标题层级、列表、链接和代码块，并为每个知识块记录原 URL、标题路径和内容 revision。</p>
        <div className="promise-row"><span><Check size={16} /> 三种本地导出</span><span><Check size={16} /> 逐条来源定位</span><span><Check size={16} /> SSRF 安全防护</span></div>
      </section>}

      {result && <>
        <MetadataStrip result={result} />
        {result.warnings.map((item) => <section className="warning-banner" key={`${item.code}-${item.message}`}><AlertTriangle size={20} /><div><strong>{item.code === 'PROMPT_INJECTION_LIKE_TEXT' ? '检测到不可信指令文本' : item.code === 'SECRET_REDACTED' ? '检测到并遮蔽疑似敏感信息' : '处理提示'}</strong><p>{item.message}</p></div></section>)}
        <section className="workspace">
          <PageInfo result={result} />
          <section className="content-panel">
            <div className="tabs">
              <div role="tablist" aria-label="结果视图">
                <button role="tab" aria-selected={view === 'markdown'} tabIndex={view === 'markdown' ? 0 : -1} className={view === 'markdown' ? 'active' : ''} onClick={() => setView('markdown')} onKeyDown={(event) => handleTabKey(event, RESULT_VIEWS, view, setView)}>清理后 Markdown</button>
                <button role="tab" aria-selected={view === 'facts'} tabIndex={view === 'facts' ? 0 : -1} className={view === 'facts' ? 'active' : ''} onClick={() => setView('facts')} onKeyDown={(event) => handleTabKey(event, RESULT_VIEWS, view, setView)}>摘要与事实</button>
                <button role="tab" aria-selected={view === 'page'} tabIndex={view === 'page' ? 0 : -1} className={view === 'page' ? 'active' : ''} onClick={() => setView('page')} onKeyDown={(event) => handleTabKey(event, RESULT_VIEWS, view, setView)}>页面元数据</button>
              </div>
              <button className="copy-button" onClick={() => void copyMarkdown()}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? '已复制' : '复制'}</button>
            </div>
            {view === 'markdown' && <MarkdownViewer markdown={result.markdown} />}
            {view === 'facts' && <FactsViewer result={result} />}
            {view === 'page' && <div className="json-view"><pre>{JSON.stringify(result.snapshot, null, 2)}</pre></div>}
          </section>
          <ChunkList chunks={result.chunks} excluded={excluded} onToggle={toggleExcluded} onEdit={editChunkTitle} />
        </section>
        <ExportBar result={result} excluded={excluded} onError={setError} />
      </>}
      </> : null}
    </main>
    <footer className="app-footer"><span>Page2Knowledge 0.2.1 · 来源可追溯知识工作台</span><span>公开可访问 ≠ 内容版权授权 · 请遵守原网站与本地数据政策</span></footer>
  </div>;
}
