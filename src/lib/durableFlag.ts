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

const forceCapture = process.env.EXPO_PUBLIC_FORCE_DURABLE_CAPTURE === 'true';
const FLAG_STORAGE_KEY = 'captivet_durable_capture_flag';

/** `null` = nothing known in this process yet (never learned, not hydrated). */
let captureEnabled: boolean | null = forceCapture ? true : null;
/** What storage is known to hold: the last write that succeeded, or what hydration read. */
let persistedValue: boolean | null = null;
/** The newest value an API response stated; storage must end up holding this. */
let desiredValue: boolean | null = null;
let writeInFlight = false;

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
 * on VetSOAP-Mobile#234). A failed write stops the loop; the next response
 * retries. A hung write blocks only persistence: the in-memory flag still
 * follows every response.
 */
function persist(value: boolean): void {
  desiredValue = value;
  if (writeInFlight || persistedValue === value) return;
  writeInFlight = true;
  void drainWrites();
}

async function drainWrites(): Promise<void> {
  try {
    while (desiredValue !== null && desiredValue !== persistedValue) {
      const value = desiredValue;
      let ok = false;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { secureStorage } = require('./secureStorage') as typeof import('./secureStorage');
        ok = await secureStorage.setRawItem(FLAG_STORAGE_KEY, value ? 'true' : 'false', 'durableFlag.persist');
      } catch {
        ok = false;
      }
      if (!ok) return;
      persistedValue = value;
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
// Set once the memoized read has settled (either way), so every record-start
// after the first takes a synchronous fast path instead of arming a timer.
let hydrationSettled = false;

/**
 * Hydrate the flag from storage at app startup, before any record-start check.
 * Memoized: repeated calls share one SecureStore read.
 */
export function hydrateDurableCaptureFlag(): Promise<void> {
  if (!hydrationPromise) {
    hydrationPromise = (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { secureStorage } = require('./secureStorage') as typeof import('./secureStorage');
        const stored = await secureStorage.getRawItem(FLAG_STORAGE_KEY, 'durableFlag.hydrate');
        const parsed = stored === 'true' ? true : stored === 'false' ? false : null;
        if (parsed !== null) {
          if (persistedValue === null) persistedValue = parsed;
          if (captureEnabled === null) captureEnabled = parsed;
        }
      } catch {
        /* best-effort: an unknown flag stays OFF */
      } finally {
        hydrationSettled = true;
      }
    })();
  }
  return hydrationPromise;
}

/**
 * Await hydration (bounded) before a record-start decision, so a cold start
 * cannot race past a stored flag that has not loaded yet. Times out toward the
 * fail-safe OFF rather than blocking record-start on a hung Keystore (rule 24).
 */
export async function ensureDurableCaptureFlagHydrated(timeoutMs = 2000): Promise<void> {
  if (hydrationSettled) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    hydrateDurableCaptureFlag(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ])
    .catch(() => {})
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
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
}
