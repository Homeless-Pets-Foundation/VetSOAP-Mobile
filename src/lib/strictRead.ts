/**
 * Typed sentinel for a STRICT local read that could not be completed.
 *
 * The lenient readers across draft/stash/vault storage collapse Keystore
 * failures, torn chunks, malformed JSON, and unusable generations into
 * `[]`/`null` — indistinguishable from "there is nothing here". That is safe
 * for best-effort cleanup and fatal for anything that must decide "is there
 * un-sent work?" or "may I delete this server row?": a failed read would read
 * as all-clear.
 *
 * Strict readers throw this instead, and their callers convert it to an
 * explicit `unknown` state. The message is deliberately generic — a raw native
 * error string must never reach UI, analytics, or Sentry (CLAUDE.md rule 3/12).
 */
export class StrictReadUnavailableError extends Error {
  readonly code = 'STRICT_READ_UNAVAILABLE';
  /** Coarse, PHI-free source label (e.g. `secure_store:draft_meta`). */
  readonly source: string;

  constructor(source: string) {
    super('A local read could not be completed');
    this.name = 'StrictReadUnavailableError';
    this.source = source;
  }
}

export function isStrictReadUnavailable(error: unknown): error is StrictReadUnavailableError {
  return (
    error instanceof StrictReadUnavailableError ||
    (!!error &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === 'STRICT_READ_UNAVAILABLE')
  );
}

/** Tri-state result for a check that can legitimately be "we could not tell". */
export type StrictExistence = 'present' | 'missing' | 'unknown';
