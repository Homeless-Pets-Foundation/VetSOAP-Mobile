import { API_URL } from '../config';
import { secureStorage } from '../lib/secureStorage';
import { validateRequestUrl } from '../lib/sslPinning';
import { getSigningHeaders } from '../lib/requestSigning';

const REQUEST_TIMEOUT_MS = 30000;
const UPLOAD_TIMEOUT_MS = 300000; // 5 minutes for large file uploads

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public isRetryable: boolean = false,
    public details?: Array<{ field?: string; message: string }>
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

  setOnUnauthorized(callback: () => void) {
    this.onUnauthorized = callback;
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

    // Validate the request targets a trusted domain over HTTPS
    validateRequestUrl(url);

    const serializedBody = body ? JSON.stringify(body) : undefined;
    const authHeaders = await this.getAuthHeaders();
    const signingHeaders = await getSigningHeaders(method, path, serializedBody);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
          ...signingHeaders,
        },
        body: serializedBody,
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 401) {
          this.onUnauthorized?.();
        }

        const errorBody = await response.json().catch(() => ({}));

        // In production, use generic messages for server errors to avoid
        // leaking internal implementation details to the client.
        let message: string;
        if (__DEV__) {
          message =
            errorBody.error ||
            (errorBody.details?.length
              ? errorBody.details.map((d: { message: string }) => d.message).join(', ')
              : `Request failed: ${response.status}`);
        } else if (response.status === 401) {
          message = 'Your session has expired. Please sign in again.';
        } else if (response.status === 403) {
          message = 'You do not have permission to perform this action.';
        } else if (response.status === 404) {
          message = 'The requested resource was not found.';
        } else if (response.status === 422 && errorBody.details?.length) {
          // Validation errors are safe to show
          message = errorBody.details.map((d: { message: string }) => d.message).join(', ');
        } else if (response.status === 429) {
          message = 'Too many requests. Please try again shortly.';
        } else if (response.status >= 500) {
          message = 'A server error occurred. Please try again later.';
        } else {
          message = errorBody.error || 'Something went wrong. Please try again.';
        }

        throw new ApiError(
          message,
          response.status,
          response.status === 429 || response.status >= 500,
          __DEV__ ? errorBody.details : undefined
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
