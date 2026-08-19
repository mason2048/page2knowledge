import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_MINIMUM_INTERVAL_MS = 15 * 60 * 1_000;
const SCHEDULER_SCHEMA_VERSION = 1 as const;
const DEFAULT_MAX_FAILURE_RECORDS = 25;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type SchedulerClock = {
  now(): Date | number;
};

export type ScheduledFetchRequest = {
  taskId: string;
  url: string;
  scheduledAt: string;
  previousRevision: string | null;
};

export type ScheduledFetchResult = {
  revision?: string;
  changed?: boolean;
  itemCount?: number;
  note?: string;
  metadata?: Record<string, JsonValue>;
};

export type ScheduledFetcher = (request: ScheduledFetchRequest) => Promise<ScheduledFetchResult | void>;

export type ScheduleFailure = {
  occurredAt: string;
  message: string;
};

export type ScheduleTask = {
  id: string;
  url: string;
  intervalMs: number;
  enabled: boolean;
  confirmed: boolean;
  status: 'idle' | 'running' | 'disabled';
  createdAt: string;
  updatedAt: string;
  nextRunAt: string;
  lockAcquiredAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  lastRevision: string | null;
  lastResult: ScheduledFetchResult | null;
  runCount: number;
  successCount: number;
  failureCount: number;
  failures: ScheduleFailure[];
};

export type CreateScheduleInput = {
  id?: string;
  url: string;
  intervalMs: number;
  /** Both flags must be explicitly true. No task is enabled by default. */
  enabled: boolean;
  confirmed: boolean;
  startAt?: string;
};

export type SchedulerOptions = {
  statePath: string;
  fetcher: ScheduledFetcher;
  clock?: SchedulerClock;
  minimumIntervalMs?: number;
  maxFailureRecords?: number;
};

export type ScheduleRunResult = {
  taskId: string;
  status: 'success' | 'failed' | 'skipped';
  startedAt: string | null;
  finishedAt: string;
  reason?: 'NOT_DUE' | 'DISABLED' | 'LOCKED';
  error?: string;
  result?: ScheduledFetchResult;
};

type PersistedSchedulerState = {
  schemaVersion: typeof SCHEDULER_SCHEMA_VERSION;
  updatedAt: string;
  tasks: ScheduleTask[];
};

export class SchedulePolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SchedulePolicyError';
    this.code = code;
  }
}

const systemClock: SchedulerClock = { now: () => Date.now() };
const emptyState = (): PersistedSchedulerState => ({
  schemaVersion: SCHEDULER_SCHEMA_VERSION,
  updatedAt: new Date(0).toISOString(),
  tasks: []
});

function clone<T>(value: T): T {
  return structuredClone(value);
}

function clockMilliseconds(clock: SchedulerClock): number {
  const value = clock.now();
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(milliseconds)) throw new Error('调度时钟返回了无效时间。');
  return milliseconds;
}

function toIso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED_SECRET]')
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/giu, '[REDACTED_SECRET]')
    .slice(0, 500) || '未知抓取错误';
}

function validateUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SchedulePolicyError('INVALID_URL', '定时任务必须提供有效的 HTTP/HTTPS URL。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new SchedulePolicyError('INVALID_URL', '定时任务只支持不含凭据的 HTTP/HTTPS URL。');
  }
  return url.href;
}

function assertState(value: unknown): PersistedSchedulerState {
  if (!value || typeof value !== 'object') throw new Error('调度状态文件不是有效 JSON 对象。');
  const candidate = value as Partial<PersistedSchedulerState>;
  if (candidate.schemaVersion !== SCHEDULER_SCHEMA_VERSION || !Array.isArray(candidate.tasks)) {
    throw new Error('调度状态文件版本不受支持或内容已损坏。');
  }
  return candidate as PersistedSchedulerState;
}

function normalizeResult(value: ScheduledFetchResult | void): ScheduledFetchResult {
  if (!value) return {};
  // The declared result is JSON-only; this runtime check prevents an injected
  // fetcher from putting functions, cycles, or credentials-bearing objects on disk.
  try {
    return JSON.parse(JSON.stringify(value)) as ScheduledFetchResult;
  } catch {
    return { note: '抓取已完成，但结果元数据无法安全持久化。' };
  }
}

export class LocalFetchScheduler {
  readonly statePath: string;
  readonly minimumIntervalMs: number;
  private readonly fetcher: ScheduledFetcher;
  private readonly clock: SchedulerClock;
  private readonly maxFailureRecords: number;
  private state: PersistedSchedulerState = emptyState();
  private loaded: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly runningTaskIds = new Set<string>();

  constructor(options: SchedulerOptions) {
    if (!options.statePath?.trim()) throw new Error('必须注入调度状态文件路径。');
    if (typeof options.fetcher !== 'function') throw new Error('必须注入定时抓取函数。');
    const minimum = options.minimumIntervalMs ?? DEFAULT_MINIMUM_INTERVAL_MS;
    if (!Number.isFinite(minimum) || minimum < 1_000) throw new Error('最小抓取间隔不得低于 1 秒。');
    this.statePath = path.resolve(options.statePath);
    this.fetcher = options.fetcher;
    this.clock = options.clock ?? systemClock;
    this.minimumIntervalMs = minimum;
    this.maxFailureRecords = Math.max(1, Math.min(options.maxFailureRecords ?? DEFAULT_MAX_FAILURE_RECORDS, 250));
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        try {
          this.state = assertState(JSON.parse(await fs.readFile(this.statePath, 'utf8')) as unknown);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            this.state = emptyState();
            return;
          }
          throw error;
        }

        // A persisted running flag means the previous local process stopped
        // before releasing its lock. Recover it as a visible failure instead of
        // silently running twice or leaving the task stuck forever.
        const nowMs = clockMilliseconds(this.clock);
        const now = toIso(nowMs);
        let recovered = false;
        this.state.tasks.forEach((task) => {
          if (task.status !== 'running') return;
          recovered = true;
          const message = '上一次定时抓取在释放运行锁前中断。';
          task.status = task.enabled ? 'idle' : 'disabled';
          task.lockAcquiredAt = null;
          task.lastFailureAt = now;
          task.lastError = message;
          task.failureCount += 1;
          task.failures = [...task.failures, { occurredAt: now, message }].slice(-this.maxFailureRecords);
          task.nextRunAt = toIso(nowMs + task.intervalMs);
          task.updatedAt = now;
        });
        if (recovered) {
          this.state.updatedAt = now;
          await this.persist();
        }
      })();
    }
    await this.loaded;
  }

  private async persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      const temporaryPath = `${this.statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporaryPath, this.statePath);
      } catch (error) {
        await fs.unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    });
    await this.writeQueue;
  }

  async createTask(input: CreateScheduleInput): Promise<ScheduleTask> {
    if (input.enabled !== true) {
      throw new SchedulePolicyError('SCHEDULE_NOT_ENABLED', '只有显式设置 enabled=true 才能创建定时抓取任务。');
    }
    if (input.confirmed !== true) {
      throw new SchedulePolicyError('SCHEDULE_NOT_CONFIRMED', '创建定时抓取前必须获得用户明确确认。');
    }
    if (!Number.isFinite(input.intervalMs) || input.intervalMs < this.minimumIntervalMs) {
      throw new SchedulePolicyError(
        'INTERVAL_TOO_SHORT',
        `抓取间隔不得低于 ${this.minimumIntervalMs} 毫秒。`
      );
    }
    const url = validateUrl(input.url);
    await this.ensureLoaded();
    const nowMs = clockMilliseconds(this.clock);
    const now = toIso(nowMs);
    const startMs = input.startAt === undefined ? nowMs + input.intervalMs : Date.parse(input.startAt);
    if (!Number.isFinite(startMs)) throw new SchedulePolicyError('INVALID_START_TIME', '首次运行时间必须是有效 ISO-8601 时间。');
    const id = input.id?.trim() || `schedule-${crypto.randomUUID()}`;
    if (this.state.tasks.some((task) => task.id === id)) {
      throw new SchedulePolicyError('DUPLICATE_TASK', `定时任务 ${id} 已存在。`);
    }
    const task: ScheduleTask = {
      id,
      url,
      intervalMs: input.intervalMs,
      enabled: true,
      confirmed: true,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      nextRunAt: toIso(startMs),
      lockAcquiredAt: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      lastRevision: null,
      lastResult: null,
      runCount: 0,
      successCount: 0,
      failureCount: 0,
      failures: []
    };
    this.state.tasks.push(task);
    this.state.tasks.sort((left, right) => left.id.localeCompare(right.id));
    this.state.updatedAt = now;
    await this.persist();
    return clone(task);
  }

  async disableTask(taskId: string): Promise<ScheduleTask> {
    await this.ensureLoaded();
    if (this.runningTaskIds.has(taskId)) {
      throw new SchedulePolicyError('TASK_RUNNING', '任务正在运行，暂时不能修改启用状态。');
    }
    const task = this.state.tasks.find((item) => item.id === taskId);
    if (!task) throw new SchedulePolicyError('TASK_NOT_FOUND', `未找到定时任务 ${taskId}。`);
    const now = toIso(clockMilliseconds(this.clock));
    task.enabled = false;
    task.status = 'disabled';
    task.updatedAt = now;
    this.state.updatedAt = now;
    await this.persist();
    return clone(task);
  }

  async listTasks(): Promise<ScheduleTask[]> {
    await this.ensureLoaded();
    await this.writeQueue;
    return clone(this.state.tasks);
  }

  async getTask(taskId: string): Promise<ScheduleTask | null> {
    await this.ensureLoaded();
    await this.writeQueue;
    const task = this.state.tasks.find((item) => item.id === taskId);
    return task ? clone(task) : null;
  }

  async runTask(taskId: string, options: { force?: boolean } = {}): Promise<ScheduleRunResult> {
    await this.ensureLoaded();
    const task = this.state.tasks.find((item) => item.id === taskId);
    if (!task) throw new SchedulePolicyError('TASK_NOT_FOUND', `未找到定时任务 ${taskId}。`);
    const checkedAtMs = clockMilliseconds(this.clock);
    const checkedAt = toIso(checkedAtMs);
    if (!task.enabled || !task.confirmed) {
      return { taskId, status: 'skipped', startedAt: null, finishedAt: checkedAt, reason: 'DISABLED' };
    }
    if (this.runningTaskIds.has(taskId) || task.status === 'running') {
      return { taskId, status: 'skipped', startedAt: null, finishedAt: checkedAt, reason: 'LOCKED' };
    }
    if (!options.force && Date.parse(task.nextRunAt) > checkedAtMs) {
      return { taskId, status: 'skipped', startedAt: null, finishedAt: checkedAt, reason: 'NOT_DUE' };
    }

    this.runningTaskIds.add(taskId);
    task.status = 'running';
    task.lockAcquiredAt = checkedAt;
    task.lastAttemptAt = checkedAt;
    task.runCount += 1;
    task.updatedAt = checkedAt;
    this.state.updatedAt = checkedAt;
    await this.persist();

    try {
      const rawResult = await this.fetcher({
        taskId: task.id,
        url: task.url,
        scheduledAt: checkedAt,
        previousRevision: task.lastRevision
      });
      const result = normalizeResult(rawResult);
      const finishedAtMs = clockMilliseconds(this.clock);
      const finishedAt = toIso(finishedAtMs);
      task.status = 'idle';
      task.lockAcquiredAt = null;
      task.lastSuccessAt = finishedAt;
      task.lastError = null;
      task.lastResult = result;
      task.lastRevision = result.revision ?? task.lastRevision;
      task.successCount += 1;
      task.nextRunAt = toIso(finishedAtMs + task.intervalMs);
      task.updatedAt = finishedAt;
      this.state.updatedAt = finishedAt;
      await this.persist();
      return { taskId, status: 'success', startedAt: checkedAt, finishedAt, result };
    } catch (error) {
      const finishedAtMs = clockMilliseconds(this.clock);
      const finishedAt = toIso(finishedAtMs);
      const message = sanitizeError(error);
      task.status = 'idle';
      task.lockAcquiredAt = null;
      task.lastFailureAt = finishedAt;
      task.lastError = message;
      task.failureCount += 1;
      task.failures = [...task.failures, { occurredAt: finishedAt, message }].slice(-this.maxFailureRecords);
      task.nextRunAt = toIso(finishedAtMs + task.intervalMs);
      task.updatedAt = finishedAt;
      this.state.updatedAt = finishedAt;
      await this.persist();
      return { taskId, status: 'failed', startedAt: checkedAt, finishedAt, error: message };
    } finally {
      this.runningTaskIds.delete(taskId);
    }
  }

  /** Run one deterministic scheduling tick. Construction never starts a timer. */
  async runDueTasks(): Promise<ScheduleRunResult[]> {
    await this.ensureLoaded();
    const nowMs = clockMilliseconds(this.clock);
    const dueIds = this.state.tasks
      .filter((task) => task.enabled && task.confirmed && task.status !== 'running' && Date.parse(task.nextRunAt) <= nowMs)
      .map((task) => task.id);
    return Promise.all(dueIds.map((taskId) => this.runTask(taskId)));
  }
}
