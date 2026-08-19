import { useEffect, useState } from 'react';
import { CalendarClock, CheckCircle2, Clock3, Play, RefreshCw, Trash2 } from 'lucide-react';
import type { ScheduleRecord } from '../../shared/types';
import { apiRequest, postJson } from '../api';

export function ScheduleWorkspace({ defaultUrl }: { defaultUrl: string }) {
  const [url, setUrl] = useState(defaultUrl);
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [confirmed, setConfirmed] = useState(false);
  const [tasks, setTasks] = useState<ScheduleRecord[]>([]);
  const [message, setMessage] = useState('');

  async function refresh() {
    const data = await apiRequest<{ tasks: ScheduleRecord[] }>('/api/schedules');
    setTasks(data.tasks);
  }
  useEffect(() => { void refresh().catch(() => undefined); }, []);

  async function create() {
    try {
      await postJson('/api/schedules', { url, intervalMinutes, enabled: true, confirmed });
      setConfirmed(false);
      setMessage('定时任务已创建；服务运行期间会按计划检查。');
      await refresh();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '创建失败。'); }
  }

  async function run(id: string) {
    await postJson(`/api/schedules/${id}/run`, {});
    await refresh();
  }

  async function remove(id: string) {
    await apiRequest(`/api/schedules/${id}`, { method: 'DELETE' });
    setMessage('定时任务已停用，不会继续发起网络请求。');
    await refresh();
  }

  return <section className="feature-workspace schedule-workspace">
    <div className="feature-header"><div><h1>定时抓取</h1><p>只有在你明确确认后才创建；默认不会自动为任何 URL 开启。</p></div><button className="secondary-button" onClick={() => void refresh()}><RefreshCw size={16} />刷新状态</button></div>
    <section className="schedule-form">
      <label>公开 URL<input value={url} onChange={(event) => setUrl(event.target.value)} /></label>
      <label>间隔（分钟）<input type="number" min={15} value={intervalMinutes} onChange={(event) => setIntervalMinutes(Number(event.target.value))} /></label>
      <label className="confirm-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span><strong>我确认启用定时网络请求</strong><small>目标必须是公开网页；任务遵守相同 SSRF、超时、大小和内容限制。</small></span></label>
      <button className="feature-primary" disabled={!confirmed} onClick={() => void create()}><CalendarClock size={17} />创建任务</button>
    </section>
    {message ? <div className="inline-message">{message}</div> : null}
    <div className="schedule-list">
      {tasks.length ? tasks.map((task) => <article key={task.id}>
        <div className={`task-state ${task.enabled ? task.lastStatus : 'disabled'}`}><Clock3 size={18} /></div>
        <div className="task-main"><strong>{task.url}</strong><span>{task.enabled ? `每 ${task.intervalMinutes} 分钟 · 下次 ${new Date(task.nextRunAt).toLocaleString('zh-CN')}` : '已停用 · 不会再发起网络请求'}</span>{task.lastError ? <small>{task.lastError}</small> : null}</div>
        <div className="task-status">{task.lastStatus === 'success' && task.enabled ? <CheckCircle2 size={15} /> : null}<span>{task.enabled ? task.lastStatus : '已停用'}</span><small>{task.runCount} 次</small></div>
        <button aria-label="立即运行" disabled={!task.enabled} onClick={() => void run(task.id)}><Play size={16} /></button>
        <button aria-label="停用任务" title="停用任务" disabled={!task.enabled} onClick={() => void remove(task.id)}><Trash2 size={16} /></button>
      </article>) : <div className="feature-empty small"><CalendarClock size={32} /><h2>暂无定时任务</h2><p>至少 15 分钟一次；每个任务有运行锁和失败记录。</p></div>}
    </div>
  </section>;
}
