/**
 * Server-driven runtime flag gating NEW durable AAC capture.
 *
 * WHY server-driven (plan: Rollout And Fallback): the presign allowlist already
 * accepts audio/aac, so a premature client-side flip would upload+confirm+purge
 * locally, then fail server-side ADTS validation — stranding bytes only in R2.
 * The flag must be owned by the same deploy that ships ADTS acceptance, so a
 * client cannot enable ADTS capture against a server that cannot process it.
 *
 * Fail-safe: OFF until a server has said otherwise. The client caches the value
 * from normal API responses (header/body). RECOVERY/LISTING/UPLOAD/DISCARD/PURGE
 * of EXISTING durable manifests are NOT gated by this flag — only new capture +
 * Resume->Continue.
 *
 * Persisted + provenance-checked (Sentry REACT-NATIVE-1X). The value used to
 * live only in memory, start OFF in every process, and flip OFF on any response
 * without the header. So a fresh recording silently took the expo-audio path —
 * whose MPEG-4 file does not survive a process death — on every cold start
 * until the first API response, for an entire offline session, and after any
 * edge-proxy 502/503 page during a deploy. Production showed exactly that: a
 * frozen-then-killed process on a clinic tablet left an EXPO capture behind
 * while the server had durable capture enabled. Now:
 *
 * - The last value an API response stated is persisted and hydrated at startup.
 *   A stored value only fills an UNKNOWN in-memory state; it never overrides a
 *   value learned this session.
 * - Only a response that came through the Captivet API may move the flag
 *   (`applyDurableCaptureHeader`). The API echoes the request's X-Request-Id
 *   from middleware that predates this flag; a proxy error page, captive
 *   portal, or other non-API response does not echo it and leaves the flag
 *   alone. An API response WITHOUT the header still fails closed — that is the
 *   deploy that cannot process ADTS.
 *
 * What persistence widens: after a server rollback to a pre-ADTS deploy, a
 * device could capture durable audio from the stored value until its first
 * API response of the new process. A rollback within the same process already
 * had that window (between the last good response and the rollback); this
 * extends it across a restart.
 */

import { withPromiseTimeout } from './promiseTimeout';

const forceCapture = process.env.EXPO_PUBLIC_FORCE_DURABLE_CAPTURE === 'true';
const FLAG_STORAGE_KEY = 'captivet_durable_capture_flag';
/** Bound for one write plus its read-back (rule 24). */
const PERSIST_TIMEOUT_MS = 5_000;

/** `null` = nothing known in this process yet (never learned, not hydrated). */
let captureEnabled: boolean | null = forceCapture ? true : null;
/** What storage is known to hold: the last write that succeeded, or what hydration read. */
let persistedValue: boolean | null = null;
/** The newest value an API response stated; storage must end up holding this. */
let desiredValue: boolean | null = null;
let writeInFlight = false;
/** Bumped when an abandoned write settles; a verification that spans the bump proves nothing. */
let storageEpoch = 0;

function parseFlag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === 'true' || value === '1';
  return null;
}

/**
 * Best-effort, only on change: every API response passes through here, and on
 * the Galaxy Tab A7 Lite fleet each Keystore write is a round trip on the one
 * thread all Expo module calls share. Lazy-required (rule 1); wrapped (rule 3).
 *
 * One write at a time, always of the newest value. Two writes in flight could
 * land out of order (setRawItem retries a failed write, which can then finish
 * after a newer one), leaving a stale `true` in storage that the next offline
 * cold start would hydrate after the server turned capture off (Codex review
 * on VetSOAP-Mobile#234). A write counts only once a read-back returns it:
 * SecureStore can drop a write while resolving (rule 17). A failed,
 * unverified, or hung write (bounded at PERSIST_TIMEOUT_MS) stops the loop and
 * marks storage unknown, so the next response writes and verifies again.
 *
 * A hung write is abandoned, not cancelled; the native bridge offers no
 * cancel. It can still land after a newer write was verified, including
 * through setRawItem's retry, leaving the stale value stored while the
 * bookkeeping says otherwise (Codex review on VetSOAP-Mobile#234). So when an
 * abandoned write settles, storage is marked unknown, a verification in
 * flight across that settle is not trusted, and if the late write's value is
 * not the newest one, the newest is written again at once. Only in that case:
 * on a Keystore that keeps outliving the deadline, rewriting after every
 * settle would chain one abandoned write into the next with no response to
 * pace it.
 */
function persist(value: boolean): void {
  desiredValue = value;
  if (writeInFlight || persistedValue === value) return;
  writeInFlight = true;
  void drainWrites();
}

async function writeAndVerify(stored: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { secureStorage } = require('./secureStorage') as typeof import('./secureStorage');
  return (
    (await secureStorage.setRawItem(FLAG_STORAGE_KEY, stored, 'durableFlag.persist')) &&
    (await secureStorage.getRawItem(FLAG_STORAGE_KEY, 'durableFlag.verify')) === stored
  );
}

async function drainWrites(): Promise<void> {
  try {
    while (desiredValue !== null && desiredValue !== persistedValue) {
      const value = desiredValue;
      const epoch = storageEpoch;
      let abandoned = false;
      const attempt = writeAndVerify(value ? 'true' : 'false');
      // Registered before the deadline's own handlers, so a write that settles
      // in time runs this while `abandoned` is still false.
      const settleLate = () => {
        if (!abandoned) return;
        storageEpoch += 1;
        persistedValue = null;
        if (writeInFlight || desiredValue === null || desiredValue === value) return;
        writeInFlight = true;
        void drainWrites();
      };
      attempt.then(settleLate, settleLate);
      let ok = false;
      try {
        ok = await withPromiseTimeout(attempt, PERSIST_TIMEOUT_MS, 'durable_flag_persist_timeout');
      } catch {
        abandoned = true;
      }
      if (!ok) {
        persistedValue = null;
        return;
      }
      if (epoch === storageEpoch) persistedValue = value;
    }
  } finally {
    writeInFlight = false;
  }
}

/** Update the cached capture flag from a server-provided value. */
export function setDurableCaptureFlag(value: unknown): void {
  if (forceCapture) {
    captureEnabled = true;
    return;
  }
  const parsed = parseFlag(value);
  if (parsed === null) return;
  captureEnabled = parsed;
  persist(parsed);
}

/**
 * Apply the `X-Durable-Capture-Enabled` header from an ApiClient response.
 * `fromApi` must be true only when the response provably passed through the
 * Captivet API (its X-Request-Id echo matches the request's). From the API, an
 * ABSENT header fails closed; from anything else, the flag is left untouched.
 */
export function applyDurableCaptureHeader(headerValue: string | null, fromApi: boolean): void {
  if (!fromApi) return;
  setDurableCaptureFlag(headerValue !== null ? headerValue : false);
}

let hydrationPromise: Promise<void> | null = null;
// Set once a read has succeeded, so every record-start after it takes a
// synchronous fast path instead of arming a timer.
let hydrationSettled = false;
// Identifies the read currently in charge. A read retired for outliving its
// bound may still settle later; it must not mark hydration done and so cancel
// the retry (Codex review on VetSOAP-Mobile#234).
let hydrationGeneration = 0;

async function readStoredFlag(): Promise<boolean | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { secureStorage } = require('./secureStorage') as typeof import('./secureStorage');
  // Strict: a Keystore failure rejects instead of reading as "nothing stored".
  const stored = await secureStorage.getRawItemStrict(FLAG_STORAGE_KEY, 'durableFlag.hydrate');
  return stored === 'true' ? true : stored === 'false' ? false : null;
}

/**
 * Hydrate the flag from storage at app startup, before any record-start check.
 * Memoized: repeated calls share one SecureStore read.
 *
 * Only a successful read settles hydration; a key proven absent counts. A read
 * that fails is retired so the next record-start reads again: the lenient read
 * returned `null` for a Keystore failure, which marked hydration done and left
 * a stored `true` ignored for the rest of the process (Codex review on
 * VetSOAP-Mobile#234).
 */
export function hydrateDurableCaptureFlag(): Promise<void> {
  if (!hydrationPromise) {
    const generation = ++hydrationGeneration;
    hydrationPromise = readStoredFlag().then(
      (parsed) => {
        if (parsed !== null) {
          // Once a response has started writes, this read may predate a write
          // that landed since; the write path alone vouches for storage then.
          if (persistedValue === null && desiredValue === null) persistedValue = parsed;
          if (captureEnabled === null) captureEnabled = parsed;
        }
        if (generation === hydrationGeneration) hydrationSettled = true;
      },
      () => {
        // Unreadable, not absent. An unknown flag stays OFF meanwhile.
        if (generation === hydrationGeneration) hydrationPromise = null;
      },
    );
  }
  return hydrationPromise;
}

/**
 * Await hydration (bounded) before a record-start decision, so a cold start
 * cannot race past a stored flag that has not loaded yet. Times out toward the
 * fail-safe OFF rather than blocking record-start on a hung Keystore (rule 24).
 *
 * A read that outlives the bound may never settle. It is retired, so the next
 * record-start issues a fresh read instead of racing the same dead promise for
 * the rest of the process (Codex review on VetSOAP-Mobile#234).
 */
export async function ensureDurableCaptureFlagHydrated(timeoutMs = 2000): Promise<void> {
  if (hydrationSettled) return;
  const attempt = hydrateDurableCaptureFlag();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  await Promise.race([
    attempt,
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
    }),
  ])
    .catch(() => {})
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
  if (timedOut && !hydrationSettled && hydrationPromise === attempt) {
    hydrationPromise = null;
    hydrationGeneration += 1;
  }
}

/** Whether NEW durable capture is enabled (server-driven; OFF while unknown). */
export function isDurableCaptureEnabled(): boolean {
  return captureEnabled === true;
}

/** Test-only reset. */
export function __resetDurableCaptureFlag(): void {
  captureEnabled = forceCapture ? true : null;
  persistedValue = null;
  desiredValue = null;
  writeInFlight = false;
  hydrationPromise = null;
  hydrationSettled = false;
  hydrationGeneration += 1;
}
