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

/**
 * Upper bound on a chunk count. Chunks are 2KB (the Android SecureStore limit),
 * so this is orders of magnitude above any real store while still rejecting a
 * corrupt value that would drive an enormous read loop.
 */
const MAX_STRICT_CHUNK_COUNT = 999_999;

/**
 * Parse a chunked-store count STRICTLY: the whole string must encode a bounded
 * non-negative integer.
 *
 * `parseInt` is unusable here because it accepts a numeric PREFIX — `'0junk'`
 * and `'0.5'` both become `0`, which a strict reader would then certify as
 * "this generation is empty" without reading a single chunk. That is precisely
 * the false all-clear (and the destructive `none` recovery anchor) the strict
 * path exists to prevent, so a malformed count must be `unknown` instead.
 */
export function parseStrictChunkCount(raw: string, source: string): number {
  if (typeof raw !== 'string' || !/^[0-9]{1,6}$/.test(raw)) {
    throw new StrictReadUnavailableError(source);
  }
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_STRICT_CHUNK_COUNT) {
    throw new StrictReadUnavailableError(source);
  }
  return count;
}
