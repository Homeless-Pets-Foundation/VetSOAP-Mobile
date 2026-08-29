/**
 * API error types, deliberately dependency-free.
 *
 * They live apart from `client.ts` because that module pulls in
 * `expo-secure-store`, `expo-crypto` and the SSL-pinning chain — none of which
 * an error type needs, and all of which make these classes unloadable outside
 * a React Native runtime. `instanceof` is the classification contract (see
 * fetchUserErrors.ts), so the classes have to be reachable from a plain Node
 * test. `client.ts` re-exports all three, so every existing importer is
 * unaffected.
 */
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

/**
 * Our own request deadline fired while `fetch()` was in flight.
 *
 * The MESSAGE is load-bearing and must not change: TRANSIENT_R2_ERROR_RE in
 * uploadRetry.ts matches the word "timeout" so the upload flow auto-retries,
 * and tests/draft-presence.test.mjs uses the string as a fixture. The TYPE
 * exists because message-matching is not a classification contract — callers
 * that need to know "this was a timeout" ask the type. Without it,
 * `isRetryableFetchUserError` saw a bare Error, called a /auth/me timeout
 * terminal, and skipped the cached-profile fallback that keeps an offline vet
 * in the app with their un-uploaded drafts.
 */
export class RequestTimeoutError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RequestTimeoutError';
  }
}

/**
 * A SecureStore read on the request path exceeded its deadline.
 *
 * Deliberately FAILS CLOSED. The alternative — dropping `X-Device-Id` and
 * letting the request go — is worse: the server answers 401
 * DEVICE_ID_REQUIRED, which forces a sign-out. Only a TIMEOUT produces this; a
 * device that genuinely has no id yet still resolves normally.
 */
export class StorageUnavailableError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super('Secure storage is not responding. Restart the app and try again.');
    this.name = 'StorageUnavailableError';
    this.operation = operation;
  }
}

/**
 * Identity-safe type guards.
 *
 * `instanceof` alone is not reliable across module-instance boundaries: a
 * bundler (or a test harness that evaluates a module twice) can produce two
 * distinct class objects for the same source, and `instanceof` then answers
 * false for a genuinely-correct error. The codebase already relies on the
 * `.name` form for exactly this reason — rule 22 matches GoTrue's
 * `AuthRetryableFetchError` by name. Check both.
 */
export function isRequestTimeoutError(error: unknown): error is RequestTimeoutError {
  if (error instanceof RequestTimeoutError) return true;
  return error instanceof Error && error.name === 'RequestTimeoutError';
}

export function isStorageUnavailableError(error: unknown): error is StorageUnavailableError {
  if (error instanceof StorageUnavailableError) return true;
  return error instanceof Error && error.name === 'StorageUnavailableError';
}

export function isApiError(error: unknown): error is ApiError {
  if (error instanceof ApiError) return true;
  return error instanceof Error && error.name === 'ApiError';
}
