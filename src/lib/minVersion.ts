/**
 * Server-enforced minimum app-version floor (plan: Phase 1 deliverable).
 *
 * The server returns a min-version floor (in a 426 response body and/or a
 * response header). The client caches it from normal API responses and, at
 * record-start, consults the CACHED floor SYNCHRONOUSLY (no new network
 * round-trip on the offline-first record path) to gate ONLY starting a new
 * recording / Resume->Continue. Already-captured local audio must always stay
 * uploadable on sub-floor builds.
 *
 * Fail direction: known-below-floor -> block (even offline); floor unknown
 * (never synced) -> fail OPEN (allow) so a never-synced device is not bricked.
 *
 * The 426 itself is handled by a dedicated ApiClient branch as terminal-non-auth
 * (no refresh, no sign-out, no retry) — never the generic buildErrorMessage
 * fallthrough.
 */

export const UPGRADE_REQUIRED_CODE = 'UPGRADE_REQUIRED';

let cachedFloor: string | null = null;

const VERSION_RE = /^\d+(\.\d+)*$/;
const FLOOR_STORAGE_KEY = 'captivet_min_version_floor';

/** Cache a floor reported by the server. Ignores malformed values. */
export function setMinVersionFloor(version: unknown): void {
  if (typeof version === 'string' && VERSION_RE.test(version.trim())) {
    cachedFloor = version.trim();
    // Persist so a KNOWN-below-floor build still blocks record-start offline after
    // a process restart. Without this, cachedFloor resets to null on relaunch and
    // an offline device would treat the floor as unknown (fail-open) until the
    // next API response re-learns it — silently allowing new recordings. Lazy +
    // best-effort (Rule 3: SecureStore wrapped); never throws at module load.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { secureStorage } = require('./secureStorage') as typeof import('./secureStorage');
      secureStorage.setRawItem(FLOOR_STORAGE_KEY, cachedFloor, 'minVersion.persistFloor').catch(() => {});
    } catch {
      /* persistence unavailable — in-memory floor still gates this session */
    }
  }
}

let hydrationPromise: Promise<void> | null = null;

/**
 * Hydrate the cached floor from persistent storage at app startup (before any
 * record-start gate check). A stored floor only fills an UNKNOWN in-memory value;
 * a fresher floor already learned this session is never downgraded. Memoized so
 * repeated calls share one SecureStore read.
 */
export function hydrateMinVersionFloor(): Promise<void> {
  if (!hydrationPromise) {
    hydrationPromise = (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { secureStorage } = require('./secureStorage') as typeof import('./secureStorage');
        const stored = await secureStorage.getRawItem(FLOOR_STORAGE_KEY, 'minVersion.hydrateFloor');
        if (!cachedFloor && typeof stored === 'string' && VERSION_RE.test(stored.trim())) {
          cachedFloor = stored.trim();
        }
      } catch {
        /* best-effort; unknown floor fails open (allow) */
      }
    })();
  }
  return hydrationPromise;
}

/**
 * Await floor hydration (bounded) before a record-start gate check, so an offline
 * cold start can't allow record-start on a known-below-floor build before the
 * persisted floor has loaded into memory. Kicks off hydration if not started;
 * times out (fail-open) rather than blocking record-start on a hung SecureStore.
 */
export async function ensureFloorHydrated(timeoutMs = 2000): Promise<void> {
  await Promise.race([
    hydrateMinVersionFloor(),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]).catch(() => {});
}

export function getMinVersionFloor(): string | null {
  return cachedFloor;
}

/** Test-only reset hook. */
export function __resetMinVersionFloor(): void {
  cachedFloor = null;
  hydrationPromise = null;
}

/** Compare dotted numeric versions. Returns <0, 0, >0. Missing parts = 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

export function isVersionBelow(current: string, floor: string): boolean {
  return compareVersions(current, floor) < 0;
}

/** Current marketing app version (lazy require so old dev clients don't crash). */
export function getCurrentAppVersion(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const App = require('expo-application') as { nativeApplicationVersion?: string | null };
    if (typeof App.nativeApplicationVersion === 'string') return App.nativeApplicationVersion;
  } catch {
    /* fall through */
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Constants = require('expo-constants') as {
      default?: { expoConfig?: { version?: string } };
    };
    const v = Constants.default?.expoConfig?.version;
    if (typeof v === 'string') return v;
  } catch {
    /* fall through */
  }
  return null;
}

export type RecordStartGate = 'allow' | 'block';

/**
 * Synchronous record-start gate. Blocks ONLY when the cached floor is known and
 * the current build is below it; unknown floor or unknown current version fails
 * open (allow).
 */
export function getRecordStartGate(): RecordStartGate {
  const floor = cachedFloor;
  if (!floor) return 'allow'; // never synced -> don't brick
  const current = getCurrentAppVersion();
  if (!current) return 'allow'; // can't determine -> fail open
  return isVersionBelow(current, floor) ? 'block' : 'allow';
}
