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

/** Cache a floor reported by the server. Ignores malformed values. */
export function setMinVersionFloor(version: unknown): void {
  if (typeof version === 'string' && VERSION_RE.test(version.trim())) {
    cachedFloor = version.trim();
  }
}

export function getMinVersionFloor(): string | null {
  return cachedFloor;
}

/** Test-only reset hook. */
export function __resetMinVersionFloor(): void {
  cachedFloor = null;
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
