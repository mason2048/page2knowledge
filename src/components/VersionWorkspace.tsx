import { useRef, useState } from 'react';
import { ArrowRight, Check, FileUp, GitCompareArrows, Minus, Plus, TriangleAlert } from 'lucide-react';
import type { ContextPackage, KnowledgeResult, KnowledgeVersionDiff } from '../../shared/types';
import { apiRequest, postJson } from '../api';

type ExtractResponse = KnowledgeResult & { contextPackage: ContextPackage };

function loadJson(file: File): Promise<ExtractResponse> {
  return file.text().then((text) => JSON.parse(text) as ExtractResponse);
}

function statusIcon(status: string) {
  if (status === 'added') return <Plus size={15} />;
  if (status === 'removed') return <Minus size={15} />;
  if (status === 'changed') return <TriangleAlert size={15} />;
  return <Check size={15} />;
}

export function VersionWorkspace({ current }: { current: ExtractResponse | null }) {
  const [before, setBefore] = useState<ExtractResponse | null>(null);
  const [after, setAfter] = useState<ExtractResponse | null>(current);
  const [diff, setDiff] = useState<KnowledgeVersionDiff | null>(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState('');
  const beforeRef = useRef<HTMLInputElement>(null);
  const afterRef = useRef<HTMLInputElement>(null);

  async function compare() {
    const nextAfter = after ?? current;
    if (!before || !nextAfter) {
      setError('请先导入旧版和新版知识包；当前转换结果可直接作为新版。');
      return;
    }
    try {
      const data = await postJson<KnowledgeVersionDiff>('/api/versions/compare', { before, after: nextAfter });
      setDiff(data);
      setSelected(Math.max(0, data.blocks.findIndex((block) => block.status !== 'unchanged')));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '版本比较失败。');
    }
  }

  async function loadExample() {
    try {
      const data = await apiRequest<{ before: ExtractResponse; after: ExtractResponse; diff: KnowledgeVersionDiff }>('/api/example/versions');
      setBefore(data.before);
      setAfter(data.after);
      setDiff(data.diff);
      setSelected(Math.max(0, data.diff.blocks.findIndex((item) => item.status !== 'unchanged')));
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '示例加载失败。'); }
  }

  const block = diff?.blocks[selected];
  return <section className="feature-workspace version-workspace">
    <div className="feature-header">
      <div><h1>版本差异</h1><p>导入同一 URL 的两版知识包，定位变化及可能过期的知识条目。</p></div>
      <div className="feature-actions"><button className="secondary-button" onClick={() => void loadExample()}>加载示例差异</button><button className="feature-primary" onClick={() => void compare()}><GitCompareArrows size={17} />开始比较</button></div>
    </div>
    <div className="version-inputs">
      <button className={before ? 'version-source ready' : 'version-source'} onClick={() => beforeRef.current?.click()}>
        <FileUp size={20} /><span><strong>旧版本</strong><small>{before ? `${before.snapshot.title} · ${new Date(before.snapshot.fetchedAt).toLocaleString('zh-CN')}` : '导入结构化 JSON'}</small></span>
      </button>
      <ArrowRight size={18} />
      <button className={(after ?? current) ? 'version-source ready' : 'version-source'} onClick={() => afterRef.current?.click()}>
        <FileUp size={20} /><span><strong>新版本</strong><small>{(after ?? current) ? `${(after ?? current)!.snapshot.title} · 当前结果` : '导入结构化 JSON'}</small></span>
      </button>
      <input ref={beforeRef} hidden type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadJson(file).then(setBefore).catch(() => setError('旧版本 JSON 无法解析。')); }} />
      <input ref={afterRef} hidden type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadJson(file).then(setAfter).catch(() => setError('新版本 JSON 无法解析。')); }} />
    </div>
    {error ? <div className="inline-error">{error}</div> : null}
    {!diff ? <div className="feature-empty"><GitCompareArrows size={38} /><h2>变化会按标题路径精确匹配</h2><p>比较结果包含新增、删除、修改、不变区块和受影响事实 ID，不会仅用整页哈希笼统判断。</p></div> : <>
      <div className="diff-summary">
        <span className="changed"><strong>{diff.summary.changed}</strong>修改</span>
        <span className="added"><strong>{diff.summary.added}</strong>新增</span>
        <span className="removed"><strong>{diff.summary.removed}</strong>删除</span>
        <span className="unchanged"><strong>{diff.summary.unchanged}</strong>不变</span>
        <small>{diff.affectedChunkIds.length} 个受影响区块 · {diff.affectedFactIds.length} 条旧包兼容事实记录</small>
      </div>
      <details className="affected-list">
        <summary>查看受影响知识条目</summary>
        <div><strong>知识块</strong>{diff.affectedChunkIds.length ? <ul>{diff.affectedChunkIds.map((id) => <li key={id}><code>{id}</code></li>)}</ul> : <p>无</p>}</div>
        <div><strong>旧包事实记录</strong>{diff.affectedFactIds.length ? <ul>{diff.affectedFactIds.map((id) => <li key={id}><code>{id}</code></li>)}</ul> : <p>当前 reference-only 结果无自动事实</p>}</div>
      </details>
      <div className="diff-layout">
        <aside className="change-list">
          {diff.blocks.map((item, index) => <button key={item.matchKey} className={`${item.status} ${selected === index ? 'selected' : ''}`} onClick={() => setSelected(index)}>
            {statusIcon(item.status)}<span><strong>{item.titlePath.at(-1)}</strong><small>{item.titlePath.join(' / ')}</small></span><em>{item.status}</em>
          </button>)}
        </aside>
        <section className="diff-detail">
          {block ? <>
            <header><div><h2>{block.titlePath.join(' / ')}</h2><p>{block.beforeRevision?.slice(7, 15) ?? '无'} → {block.afterRevision?.slice(7, 15) ?? '无'}</p></div><span className={`diff-status ${block.status}`}>{block.status}</span></header>
            <div className="diff-code">{block.lineDiff.map((line, index) => <div key={`${index}-${line.kind}`} className={line.kind}><span>{line.beforeLine ?? ''}</span><span>{line.afterLine ?? ''}</span><b>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</b><code>{line.text || ' '}</code></div>)}</div>
          </> : null}
        </section>
      </div>
    </>}
  </section>;
}
