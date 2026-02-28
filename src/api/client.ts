import { API_URL } from '../config';
import { secureStorage } from '../lib/secureStorage';

const REQUEST_TIMEOUT_MS = 30000;

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public isRetryable: boolean = false
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiClient {
  private onUnauthorized?: () => void;

  constructor(opts?: { onUnauthorized?: () => void }) {
    this.onUnauthorized = opts?.onUnauthorized;
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await secureStorage.getToken();
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
  }

  async request<T>(
    path: string,
    config: {
      method?: string;
      body?: unknown;
      params?: Record<string, string | number | undefined>;
    } = {}
  ): Promise<T> {
    const { method = 'GET', body, params } = config;

    let url = `${API_URL}${path}`;
    if (params) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) search.set(key, String(value));
      }
      const qs = search.toString();
      if (qs) url += `?${qs}`;
    }

    const authHeaders = await this.getAuthHeaders();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 401) {
          this.onUnauthorized?.();
        }

        const errorBody = await response.json().catch(() => ({}));
        throw new ApiError(
          errorBody.error || `Request failed: ${response.status}`,
          response.status,
          response.status === 429 || response.status >= 500
        );
      }

      if (response.status === 204) {
        return undefined as T;
      }

      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  get<T>(path: string, params?: Record<string, string | number | undefined>) {
    return this.request<T>(path, { params });
  }

  post<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: 'POST', body });
  }

  put<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: 'PUT', body });
  }

  delete<T>(path: string) {
    return this.request<T>(path, { method: 'DELETE' });
  }
}

export const apiClient = new ApiClient();
