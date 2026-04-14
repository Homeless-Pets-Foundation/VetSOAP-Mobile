import { API_URL } from '../config';
import { secureStorage } from '../lib/secureStorage';
import { validateRequestUrl } from '../lib/sslPinning';

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
  private onDeviceRevoked?: () => void | Promise<void>;
  /** In-memory token — primary source of truth. SecureStore is a fallback. */
  private currentToken: string | null = null;
  /**
   * True once setToken() has been called at least once. Once initialized, the
   * in-memory token is authoritative and SecureStore is NOT consulted — this
   * makes setToken(null) effective immediately (fixes sign-out race where
   * requests in the window before clearAll() could still send a stale bearer).
   */
  private tokenInitialized = false;
  /** Cached device ID — read from SecureStore once, then reused. Only caches non-null values. */
  private cachedDeviceId: string | undefined = undefined; // undefined = not yet loaded/not yet successful

  constructor(opts?: { onUnauthorized?: () => void | Promise<void>; onDeviceRevoked?: () => void | Promise<void> }) {
    this.onUnauthorized = opts?.onUnauthorized;
    this.onDeviceRevoked = opts?.onDeviceRevoked;
  }

  setOnUnauthorized(callback: () => void | Promise<void>) {
    this.onUnauthorized = callback;
  }

  setOnDeviceRevoked(callback: () => void | Promise<void>) {
    this.onDeviceRevoked = callback;
  }

  /**
   * Set the access token directly (called by AuthProvider on every session change).
   * Also syncs SecureStore (persist on set, delete on clear) so a later cold-start
   * read can't resurrect a signed-out token.
   */
  setToken(token: string | null) {
    this.currentToken = token;
    this.tokenInitialized = true;
    if (token) {
      secureStorage.setToken(token).catch(() => {});
    } else {
      secureStorage.deleteToken().catch(() => {});
    }
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    // Once AuthProvider has called setToken() (even with null), the in-memory
    // value is authoritative. Only fall back to SecureStore during the cold-start
    // window before AuthProvider hydrates — otherwise setToken(null) wouldn't
    // actually stop authenticated requests.
    const token = this.tokenInitialized
      ? this.currentToken
      : (await secureStorage.getToken());
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
    if (status === 402) return (errorBody.error as string) || 'Payment required.';
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
    timeoutMs: number,
    idempotencyKey?: string
  ): Promise<Response> {
    const authHeaders = await this.getAuthHeaders();
    // Cache device ID after first successful read to avoid hitting SecureStore on every request.
    // Don't cache null — Keystore may be transiently unavailable (e.g. Android direct boot).
    if (this.cachedDeviceId === undefined) {
      const id = await secureStorage.getDeviceId();
      if (id) this.cachedDeviceId = id;
    }
    const deviceId = this.cachedDeviceId ?? null;
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
          ...(deviceId ? { 'X-Device-Id': deviceId } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
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
      idempotencyKey?: string;
    } = {}
  ): Promise<T> {
    const { method = 'GET', body, params, timeoutMs = REQUEST_TIMEOUT_MS, idempotencyKey } = config;

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
    let response = await this.doFetch(url, method, path, serializedBody, timeoutMs, idempotencyKey);

    // On 401, check for device revocation before attempting refresh
    if (response.status === 401) {
      const errorPreview = await response.clone().json().catch(() => ({})) ?? {};
      if (errorPreview.code === 'DEVICE_REVOKED') {
        // Device was revoked by admin — force sign-out without token refresh
        try { await this.onDeviceRevoked?.(); } catch { /* ignore */ }
        throw new ApiError(
          'This device has been revoked. Contact your administrator.',
          401,
          false
        );
      }
      if (errorPreview.code === 'DEVICE_ID_REQUIRED') {
        // Device ID missing (Keystore failure) — don't retry, surface clear error
        throw new ApiError(
          'Device identification failed. Please restart the app or reinstall.',
          401,
          false
        );
      }

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
        response = await this.doFetch(url, method, path, serializedBody, timeoutMs, idempotencyKey);
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

  post<T>(path: string, body?: unknown, idempotencyKey?: string) {
    return this.request<T>(path, { method: 'POST', body, idempotencyKey });
  }

  put<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: 'PUT', body });
  }

  delete<T>(path: string) {
    return this.request<T>(path, { method: 'DELETE' });
  }
}

export const apiClient = new ApiClient();
