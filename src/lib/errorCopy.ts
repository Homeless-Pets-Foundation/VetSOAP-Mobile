import { ApiError } from '../api/client';
import { ERROR_COPY } from '../constants/strings';

/**
 * Map an error to safe, friendly user copy (2026-07 audit theme E). Follows
 * the mfaPolicy.ts pattern: branch ONLY on ApiError status/code and error
 * type — never pattern-match server message text (Monitoring rules). Raw
 * detail belongs behind a "Copy details for support" action, not on screen.
 */
export function friendlyErrorMessage(
  error: unknown,
  context: 'load' | 'upload' | 'generic' = 'generic'
): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return ERROR_COPY.network;
    if (error.status === 408 || error.code === 'TIMEOUT') return ERROR_COPY.timeout;
    if (error.status === 429) return ERROR_COPY.rateLimited;
    if (error.status === 403) return ERROR_COPY.permission;
    if (error.status >= 500) return ERROR_COPY.server;
  }
  // JS-level fetch failure (no response at all) — a runtime signal, not
  // server message matching.
  if (error instanceof TypeError) return ERROR_COPY.network;
  if (context === 'load') return ERROR_COPY.loadFailed;
  if (context === 'upload') return ERROR_COPY.uploadGeneric;
  return ERROR_COPY.server;
}

/**
 * Compact technical detail for the copy-to-clipboard support path. Truncated
 * defensively; PHI never lives in error names/codes/status.
 */
export function technicalErrorDetails(error: unknown): string {
  if (error instanceof ApiError) {
    return `[ApiError ${error.status}${error.code ? ` ${error.code}` : ''}] ${error.message}`.slice(0, 512);
  }
  if (error instanceof Error) {
    return `[${error.name}] ${error.message}`.slice(0, 512);
  }
  return String(error).slice(0, 512);
}
