import { API_URL } from '../config';
import { secureStorage } from '../lib/secureStorage';
import { validateRequestUrl } from '../lib/sslPinning';
import { getSigningHeaders } from '../lib/requestSigning';

const REQUEST_TIMEOUT_MS = 30000;

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public isRetryable: boolean = false,
    public details?: { field?: string; message: string }[]
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiClient {
  private onUnauthorized?: () => void | Promise<void>;
  /** In-memory token — primary source of truth. SecureStore is a fallback. */
  private currentToken: string | null = null;

  constructor(opts?: { onUnauthorized?: () => void | Promise<void> }) {
    this.onUnauthorized = opts?.onUnauthorized;
  }

  setOnUnauthorized(callback: () => void | Promise<void>) {
    this.onUnauthorized = callback;
  }

  /**
   * Set the access token directly (called by AuthProvider on every session change).
   * Also persists to SecureStore as a best-effort backup.
   */
  setToken(token: string | null) {
    this.currentToken = token;
    if (token) {
      secureStorage.setToken(token).catch(() => {});
    }
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    // Prefer the in-memory token; fall back to SecureStore
    const token = this.currentToken ?? (await secureStorage.getToken());
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
  }

  private buildErrorMessage(
    status: number,
    errorBody: Record<string, unknown>,
    details: { message: string }[]
  ): string {
    if (__DEV__) {
      return (
        (errorBody.error as string) ||
        (details.length
          ? details.map((d) => d.message).join(', ')
          : `Request failed: ${status}`)
      );
    }
    if (status === 401) return 'Your session has expired. Please sign in again.';
    if (status === 403) return 'You do not have permission to perform this action.';
    if (status === 404) return 'The requested resource was not found.';
    if (status === 422 && details.length) return details.map((d) => d.message).join(', ');
    if (status === 429) return 'Too many requests. Please try again shortly.';
    if (status >= 500) return 'A server error occurred. Please try again later.';
    return 'Something went wrong. Please try again.';
  }

  private async doFetch(
    url: string,
    method: string,
    path: string,
    serializedBody: string | undefined,
    timeoutMs: number
  ): Promise<Response> {
    const authHeaders = await this.getAuthHeaders();
    const signingHeaders = await getSigningHeaders(method, path, serializedBody);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      validateRequestUrl(url);

      if (__DEV__) console.log('[ApiClient]', method, path, 'hasToken:', !!authHeaders.Authorization);
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...authHeaders,
          ...signingHeaders,
        },
        body: serializedBody,
        signal: controller.signal,
      });

      if (__DEV__) console.log('[ApiClient]', method, path, 'status:', response.status);
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  async request<T>(
    path: string,
    config: {
      method?: string;
      body?: unknown;
      params?: Record<string, string | number | undefined>;
      timeoutMs?: number;
    } = {}
  ): Promise<T> {
    const { method = 'GET', body, params, timeoutMs = REQUEST_TIMEOUT_MS } = config;

    let url = `${API_URL}${path}`;
    if (params) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) search.set(key, String(value));
      }
      const qs = search.toString();
      if (qs) url += `?${qs}`;
    }

    const serializedBody = body ? JSON.stringify(body) : undefined;
    let response = await this.doFetch(url, method, path, serializedBody, timeoutMs);

    // On 401, attempt token refresh and retry once with fresh credentials
    if (response.status === 401) {
      const oldToken = this.currentToken;

      try {
        await this.onUnauthorized?.();
      } catch {
        // onUnauthorized handler failed — fall through to error
      }
      const newToken = this.currentToken;

      // If the token changed after refresh, retry the request once
      if (newToken && newToken !== oldToken) {
        if (__DEV__) console.log('[ApiClient]', method, path, 'retrying after token refresh');
        response = await this.doFetch(url, method, path, serializedBody, timeoutMs);
      }
    }

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({})) ?? {};
      const details = Array.isArray(errorBody.details) ? errorBody.details : [];
      const message = this.buildErrorMessage(response.status, errorBody, details);

      throw new ApiError(
        message,
        response.status,
        response.status === 429 || response.status >= 500,
        __DEV__ ? details : undefined
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json().catch(() => {
      throw new ApiError('Invalid response format from server', response.status);
    });
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
