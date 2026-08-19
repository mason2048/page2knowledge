import { useEffect, useState } from 'react';
import { ArrowUp, BookOpenCheck, Database, MessageSquareText, Quote, Search } from 'lucide-react';
import type { ChatAnswer, ContextPackage, KnowledgeResult, SearchHit } from '../../shared/types';
import { apiRequest, postJson } from '../api';

type ExtractResponse = KnowledgeResult & { contextPackage: ContextPackage };

export function KnowledgeWorkspace({ current }: { current: ExtractResponse | null }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<ChatAnswer | null>(null);
  const [indexed, setIndexed] = useState(0);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void apiRequest<{ chunkCount: number }>('/api/knowledge/stats').then((data) => setIndexed(data.chunkCount)).catch(() => undefined);
  }, []);

  async function addCurrent() {
    if (!current) return setMessage('请先在“转换”工作区生成一个知识包。');
    try {
      const data = await postJson<{ chunkCount: number }>('/api/knowledge/index', { result: current });
      setIndexed(data.chunkCount);
      setMessage(`已索引《${current.snapshot.title}》的 ${current.chunks.length} 个区块。`);
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '索引失败。'); }
  }

  async function search() {
    if (!query.trim()) return;
    const data = await postJson<{ hits: SearchHit[] }>('/api/knowledge/search', { query, limit: 8 });
    setHits(data.hits);
  }

  async function ask() {
    if (!question.trim()) return;
    const data = await postJson<ChatAnswer>('/api/knowledge/chat', { question, limit: 5 });
    setAnswer(data);
  }

  return <section className="feature-workspace knowledge-workspace">
    <div className="feature-header">
      <div><h1>本地知识库</h1><p>本地索引、相似度检索和只依据引用证据回答的问答。</p></div>
      <button className="feature-primary" disabled={!current} onClick={() => void addCurrent()}><Database size={17} />索引当前结果</button>
    </div>
    <div className="knowledge-stats"><BookOpenCheck size={19} /><strong>{indexed}</strong><span>个知识块已保存在本地 JSON 数据库</span>{message ? <small>{message}</small> : null}</div>
    <div className="knowledge-columns">
      <section>
        <header><Search size={18} /><div><h2>语义检索</h2><p>确定性本地向量，不调用外部模型</p></div></header>
        <form className="query-form" onSubmit={(event) => { event.preventDefault(); void search(); }}><input aria-label="知识库搜索" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索知识，例如：写操作如何重试？" /><button><ArrowUp size={16} /></button></form>
        <div className="search-results">{hits.length ? hits.map((hit) => <article key={hit.chunkId}><div><strong>{hit.title}</strong><span>{Math.round(hit.score * 100)}%</span></div><p>{hit.content.slice(0, 170)}</p><small>{hit.source.titlePath.join(' / ')} · {hit.source.locator}</small></article>) : <div className="mini-empty">输入问题查找带来源的相关区块。</div>}</div>
      </section>
      <section>
        <header><MessageSquareText size={18} /><div><h2>引用式问答</h2><p>无证据时明确拒答，不补写未知内容</p></div></header>
        <form className="query-form" onSubmit={(event) => { event.preventDefault(); void ask(); }}><input aria-label="向知识库提问" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="向已索引的知识提问" /><button><ArrowUp size={16} /></button></form>
        {answer ? <article className={`chat-answer ${answer.grounded ? 'grounded' : 'ungrounded'}`}><p>{answer.answer}</p>{answer.citations.map((citation) => <a href={citation.source.url} target="_blank" rel="noreferrer" key={citation.index}><Quote size={13} />[{citation.index}] {citation.label} · {citation.source.locator}</a>)}</article> : <div className="mini-empty">回答会附带原 URL、标题路径、定位和 revision。</div>}
      </section>
    </div>
  </section>;
}
