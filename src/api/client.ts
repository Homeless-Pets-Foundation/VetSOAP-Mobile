import { API_URL } from '../config';
import { secureStorage } from '../lib/secureStorage';
import { validateRequestUrl } from '../lib/sslPinning';
import { getIdempotencyUuid } from '../lib/random';
import { setMinVersionFloor, UPGRADE_REQUIRED_CODE } from '../lib/minVersion';
import { setDurableCaptureFlag } from '../lib/durableFlag';

const REQUEST_TIMEOUT_MS = 30000;

/**
 * Classify an API path into a coarse bucket for telemetry cardinality. Full
 * paths leak PHI-adjacent identifiers (recording_id, user_id) and explode
 * PostHog property cardinality; the bucket keeps dashboards cheap. The raw
 * path still goes into the Sentry breadcrumb for one-off debugging.
 */
function endpointKindOf(path: string): 'recordings' | 'auth' | 'telemetry' | 'devices' | 'soap' | 'other' {
  if (path.startsWith('/api/recordings')) return 'recordings';
  if (path.startsWith('/api/soap-notes') || path.includes('soap-note')) return 'soap';
  if (path.startsWith('/api/telemetry')) return 'telemetry';
  if (path.startsWith('/api/device-sessions') || path.startsWith('/auth')) {
    return path.startsWith('/auth') ? 'auth' : 'devices';
  }
  return 'other';
}

function emitApiRequestFailed(
  endpointKind: ReturnType<typeof endpointKindOf>,
  status: number,
  latencyMs: number,
  retried: boolean,
): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { trackEvent } = require('../lib/analytics') as typeof import('../lib/analytics');
    trackEvent({
      name: 'api_request_failed',
      props: { endpoint_kind: endpointKind, status, latency_ms: latencyMs, retried },
    });
  } catch {
    // swallow
  }
}

function emitApiBreadcrumb(
  method: string,
  path: string,
  status: number,
  latencyMs: number,
  requestId: string,
): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { breadcrumb } = require('../lib/monitoring') as typeof import('../lib/monitoring');
    breadcrumb('network', `${method} ${path}`, {
      status,
      latency_ms: latencyMs,
      request_id: requestId,
    });
  } catch {
    // swallow
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public isRetryable: boolean = false,
    public details?: { field?: string; message: string }[],
    /** Server-supplied error code (e.g. DEVICE_LIMIT_REACHED) for branching. */
    public code?: string,
    /** Remaining error-body fields (e.g. capacity, existingDevices). */
    public data?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface MfaRequiredRequest {
  path: string;
  method: string;
  reason?: string;
  currentLevel?: string;
  nextLevel?: string;
  staleSession?: boolean;
  verifiedAt?: number | null;
  maxAgeSeconds?: number;
}

export class ApiClient {
  private onUnauthorized?: () => void | Promise<void>;
  private onDeviceRevoked?: () => void | Promise<void>;
  private onDeviceRegistrationRequired?: () => Promise<boolean>;
  private onMfaRequired?: (request: MfaRequiredRequest) => void | Promise<void>;
  /**
   * Fired when a request stays 401 *after* onUnauthorized() already ran its
   * refresh+retry — i.e. the session is unrecoverable. Lets the auth layer route
   * to sign-in instead of leaving a "zombie session" (cached UI that silently
   * fails every write). The handler applies its own fresh-session / in-progress-
   * sign-out guards before clearing.
   */
  private onSessionExpired?: () => void | Promise<void>;
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

  setOnSessionExpired(callback: () => void | Promise<void>) {
    this.onSessionExpired = callback;
  }

  setOnDeviceRevoked(callback: () => void | Promise<void>) {
    this.onDeviceRevoked = callback;
  }

  /**
   * Handler for 428 DEVICE_REGISTRATION_REQUIRED. Must return true if registration
   * succeeded (caller will retry once) or false if it failed. The server returns
   * 428 on the first /api/* call after sign-in if the device has never registered;
   * the client calls POST /api/device-sessions/register (which is exempt from
   * validateDeviceSession) and retries the original request.
   */
  setOnDeviceRegistrationRequired(callback: () => Promise<boolean>) {
    this.onDeviceRegistrationRequired = callback;
  }

  setOnMfaRequired(callback: ((request: MfaRequiredRequest) => void | Promise<void>) | null) {
    this.onMfaRequired = callback ?? undefined;
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
    if (status === 403 && errorBody.code === 'MFA_REQUIRED') {
      return (errorBody.error as string) || 'Multi-factor authentication is required.';
    }
    if (status === 403 && errorBody.code === 'ROLE_FORBIDDEN') {
      return 'Your role cannot create, upload, or delete recordings.';
    }
    if (status === 403 && errorBody.code === 'RECORDING_DELETE_FORBIDDEN') {
      return 'Only the recording owner or an administrator can delete this recording.';
    }
    if (errorBody.code === 'CREDENTIALS_REQUIRED') {
      return (
        (errorBody.error as string) ||
        (errorBody.message as string) ||
        'Service credentials are required to submit recordings.'
      );
    }
    if (status === 403) return 'You do not have permission to perform this action.';
    if (status === 404) return 'The requested resource was not found.';
    if (status === 400 && details.length) return details.map((d) => d.message).join(', ');
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
    idempotencyKey?: string,
    requestId?: string
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
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

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
          ...(requestId ? { 'X-Request-Id': requestId } : {}),
        },
        body: serializedBody,
        signal: controller.signal,
      });

      if (__DEV__) console.log('[ApiClient]', method, path, 'status:', response.status);
      return response;
    } catch (error) {
      // Our own timeout aborts surface as a bare AbortError ("Aborted"), which
      // the upload retry classifier treats as non-transient (it can't tell a
      // timeout from a user cancel). Rethrow with an explicit timeout message
      // so isTransientUploadError matches and the upload flow auto-retries.
      if (timedOut) {
        throw new Error(`Request timeout after ${timeoutMs}ms`, { cause: error });
      }
      throw error;
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
      parseJson?: boolean;
    } = {}
  ): Promise<T> {
    const {
      method = 'GET',
      body,
      params,
      timeoutMs = REQUEST_TIMEOUT_MS,
      idempotencyKey,
      parseJson = true,
    } = config;

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
    // One X-Request-Id per logical request — reused across retries so the
    // server sees them as the same "client intent." The server generates
    // its own if we ever miss setting this, but the correlation is tighter
    // when the client owns the ID. Cheap UUID — non-security context.
    const requestId = getIdempotencyUuid();
    const fetchStartedAt = Date.now();
    let retried = false;
    let response = await this.doFetch(url, method, path, serializedBody, timeoutMs, idempotencyKey, requestId);

    // Opportunistically cache the min-app-version floor from ANY response so the
    // offline-first record-start gate has a value without a dedicated round-trip.
    try {
      const headerFloor = response.headers.get('x-minimum-app-version');
      if (headerFloor) setMinVersionFloor(headerFloor);
      // Server-driven durable-capture flag: only the deploy that can process
      // ADTS AAC turns this on, so the client never captures AAC the server
      // can't handle. Absent header leaves the cached value (default off).
      const durableFlag = response.headers.get('x-durable-capture-enabled');
      if (durableFlag !== null) setDurableCaptureFlag(durableFlag);
    } catch { /* headers may be unavailable on some RN fetch polyfills */ }

    // 426 Upgrade Required is terminal-non-auth: no token refresh, no sign-out,
    // no retry (distinct from the 401 DEVICE_REVOKED force-sign-out and the
    // Rule 16/22 refresh/retry loops). Cache the floor and surface the typed code
    // the record path reads to gate; do NOT fall through to buildErrorMessage
    // (which would show a generic "Something went wrong" and block nothing).
    if (response.status === 426) {
      const upgradeBody = await response.clone().json().catch(() => ({})) ?? {};
      if (typeof upgradeBody.minVersion === 'string') setMinVersionFloor(upgradeBody.minVersion);
      const endpointKind = endpointKindOf(path);
      emitApiRequestFailed(endpointKind, 426, Date.now() - fetchStartedAt, retried);
      throw new ApiError(
        'A newer version of Captivet is required. Please update the app to continue.',
        426,
        false,
        undefined,
        typeof upgradeBody.code === 'string' ? upgradeBody.code : UPGRADE_REQUIRED_CODE,
      );
    }

    // On 428, the server is telling us this device has no session row and we
    // need to register before /api/* calls are accepted. Only the registration
    // endpoint itself is exempt from the handshake — calling it from here
    // would re-enter with the same 428, so we skip the handler for that path.
    if (response.status === 428 && path !== '/api/device-sessions/register') {
      const errorPreview = await response.clone().json().catch(() => ({})) ?? {};
      if (errorPreview.code === 'DEVICE_REGISTRATION_REQUIRED' && this.onDeviceRegistrationRequired) {
        const registered = await this.onDeviceRegistrationRequired().catch(() => false);
        if (registered) {
          if (__DEV__) console.log('[ApiClient]', method, path, 'retrying after device registration');
          retried = true;
        response = await this.doFetch(url, method, path, serializedBody, timeoutMs, idempotencyKey, requestId);
        }
      }
    }

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
        retried = true;
        response = await this.doFetch(url, method, path, serializedBody, timeoutMs, idempotencyKey, requestId);
      }

      // Still 401 after the refresh attempt → the session can't authenticate
      // (refresh failed, or produced a token the server still rejects). Tell the
      // auth layer to route to sign-in rather than stranding the user in a zombie
      // session. Fires only after a refresh already ran; transient network blips
      // surface as throws (not clean 401s) so they don't trip it.
      if (response.status === 401) {
        try { await this.onSessionExpired?.(); } catch { /* ignore */ }
      }
    }

    const latencyMs = Date.now() - fetchStartedAt;
    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({})) ?? {};
      const details = Array.isArray(errorBody.details)
        ? errorBody.details
            .map((detail: unknown): { field?: string; message: string } | null => {
              if (!detail || typeof detail !== 'object') return null;
              const raw = detail as Record<string, unknown>;
              const message = typeof raw.message === 'string' ? raw.message : '';
              if (!message) return null;
              const field =
                typeof raw.field === 'string'
                  ? raw.field
                  : Array.isArray(raw.path)
                    ? raw.path.map(String).join('.')
                    : undefined;
              return field ? { field, message } : { message };
            })
            .filter(
              (detail: { field?: string; message: string } | null): detail is { field?: string; message: string } =>
                detail !== null
            )
        : [];
      const message = this.buildErrorMessage(response.status, errorBody, details);
      const code = typeof errorBody.code === 'string' ? errorBody.code : undefined;

      if (response.status === 403 && code === 'MFA_REQUIRED') {
        await this.onMfaRequired?.({
          path,
          method,
          reason: typeof errorBody.reason === 'string' ? errorBody.reason : undefined,
          currentLevel:
            typeof errorBody.currentLevel === 'string' ? errorBody.currentLevel : undefined,
          nextLevel: typeof errorBody.nextLevel === 'string' ? errorBody.nextLevel : undefined,
          staleSession:
            typeof errorBody.staleSession === 'boolean' ? errorBody.staleSession : undefined,
          verifiedAt: typeof errorBody.verifiedAt === 'number' ? errorBody.verifiedAt : null,
          maxAgeSeconds:
            typeof errorBody.maxAgeSeconds === 'number' ? errorBody.maxAgeSeconds : undefined,
        });
      }

      // Strip the fields we lift to first-class properties so callers reading
      // `data` aren't tempted to duplicate-read them.
      const { error: _err, code: _code, details: _details, ...restData } = errorBody;
      const hasData = Object.keys(restData).length > 0;

      const endpointKind = endpointKindOf(path);
      emitApiRequestFailed(endpointKind, response.status, latencyMs, retried);
      emitApiBreadcrumb(method, path, response.status, latencyMs, requestId);

      throw new ApiError(
        message,
        response.status,
        response.status === 429 || response.status >= 500,
        __DEV__ ? details : undefined,
        code,
        hasData ? (restData as Record<string, unknown>) : undefined
      );
    }

    // Success breadcrumb so upload-path debugging has the whole conversation
    // even when no error fires. Keeps the breadcrumb ring small via the
    // `maxBreadcrumbs: 50` setting in monitoring.ts.
    emitApiBreadcrumb(method, path, response.status, latencyMs, requestId);

    if (response.status === 204 || !parseJson) {
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

  patch<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: 'PATCH', body });
  }

  delete<T>(path: string) {
    return this.request<T>(path, { method: 'DELETE' });
  }
}

export const apiClient = new ApiClient();
