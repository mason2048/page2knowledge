import type { ApiError } from '../shared/types';

const TOKEN_KEY = 'page2knowledge-access-token';

export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly suggestion: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export function getAccessToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) ?? '';
}

export function setAccessToken(token: string): void {
  const normalized = token.trim();
  if (normalized) sessionStorage.setItem(TOKEN_KEY, normalized);
  else sessionStorage.removeItem(TOKEN_KEY);
}

export async function apiRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const token = getAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(url, { ...init, headers });
  const data = await response.json().catch(() => null) as T | ApiError | null;
  if (!response.ok || (data && typeof data === 'object' && 'error' in data)) {
    const error = data && typeof data === 'object' && 'error' in data ? data.error : null;
    throw new ApiClientError(
      error?.message ?? `本地服务返回 HTTP ${response.status}。`,
      error?.code ?? 'HTTP_ERROR',
      error?.suggestion ?? '请检查服务状态后重试。',
      response.status
    );
  }
  return data as T;
}

export function postJson<T>(url: string, body: unknown): Promise<T> {
  return apiRequest<T>(url, { method: 'POST', body: JSON.stringify(body) });
}
