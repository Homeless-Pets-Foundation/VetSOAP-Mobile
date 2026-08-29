/**
 * Pure decision table behind `AppLockGuard`.
 *
 * Every method on `src/lib/biometrics.ts` already try/catches to a safe value
 * and never rejects, so the ONLY failure mode the guard can suffer is a HANG —
 * a stalled Keystore rebuild after an OS update, or a biometric service that
 * never answers. No try/catch reaches that; only a deadline does (rule 24).
 *
 * The shipped guard bounded neither path completely: the foreground-resume
 * branch set `isLocked = true` and then awaited `isAvailable()`, `isEnabled()`
 * and `authenticate()` with nothing bounding them, so a stall left a vet
 * permanently locked out of a perfectly valid session with un-uploaded
 * recordings behind the lock screen.
 *
 * This module owns WHAT to do at each outcome; the component owns the timers,
 * the native calls and the React state. `AppLockGuard.tsx` cannot be executed
 * by the test harness (`tests/helpers/loadTs.mjs` resolves `.ts` only, never
 * `.tsx`), so keeping the branching here is what makes the hang paths testable
 * by execution instead of by regex. No React, no react-native, no timers, no
 * `Date.now()` — same discipline as `src/lib/attentionFeed.ts`.
 */
import { APP_LOCK_COPY } from '../constants/strings';

/**
 * Availability probe deadline. Short: `isAvailable()`/`isEnabled()` are a
 * hardware query and a SecureStore read, not a user interaction.
 */
export const APPLOCK_PROBE_TIMEOUT_MS = 7_000;

/**
 * Prompt deadline. Generous on purpose — the OS prompt is user-driven and a
 * person may reasonably take a while. Anything past this is a broken bridge,
 * not hesitation.
 */
export const APPLOCK_PROMPT_TIMEOUT_MS = 60_000;

/** Coarse cold-start watchdog. Unchanged value, now a named constant. */
export const APPLOCK_INIT_WATCHDOG_MS = 12_000;

/** Coarse foreground-resume watchdog. Previously absent entirely. */
export const APPLOCK_RESUME_WATCHDOG_MS = 12_000;

/**
 * Tri-state cache of "a biometric lock is configured".
 *
 * This replaced a plain `boolean`. While it was a boolean, a cold-start
 * watchdog that fired before the probe assigned it left it `false`, which
 * silently disarmed the background-resume lock for the rest of the session.
 * `'unknown'` keeps that case distinguishable from a proven `'off'`.
 */
export type BgLockState = 'on' | 'off' | 'unknown';

export type ProbeOutcome =
  | { kind: 'resolved'; available: boolean; enabled: boolean }
  | { kind: 'timeout' };

/**
 * `rejected` means the prompt answered "no" — cancelled, or the check failed.
 * `timeout` means it never answered at all. Collapsing the two would tell a vet
 * to "try again" after a prompt they never saw, and would hide a broken bridge
 * inside the ordinary cancel path.
 */
export type PromptOutcome = 'success' | 'rejected' | 'timeout';

export type LockPath = 'init' | 'resume' | 'manual';

export interface AppLockTelemetry {
  readonly message: string;
  readonly phase: string;
  readonly op: string;
  readonly timeoutMs: number;
}

export type ProbeDecision =
  | { action: 'prompt'; bgLock: BgLockState; telemetry: AppLockTelemetry | null }
  | {
      action: 'settle';
      locked: boolean;
      ready: boolean;
      bgLock: BgLockState;
      hint: string | null;
      telemetry: AppLockTelemetry | null;
    };

export interface PromptDecision {
  readonly locked: boolean;
  readonly hint: string | null;
  readonly telemetry: AppLockTelemetry | null;
}

/**
 * Cold-start probe timeout. Keeps the ORIGINAL event name and the original
 * fail-open meaning: we could not determine whether a lock is configured, so
 * the user lands on content. Failing closed here would lock out every user who
 * never enabled biometrics, out of an app they never locked.
 */
const INIT_WATCHDOG: AppLockTelemetry = {
  message: 'applock_init_watchdog_fired',
  phase: 'init_watchdog',
  op: 'applock_init',
  timeoutMs: APPLOCK_PROBE_TIMEOUT_MS,
};

/** Resume prompt hung. The app STAYS LOCKED — PHI is never revealed on a timer. */
const RESUME_WATCHDOG: AppLockTelemetry = {
  message: 'applock_resume_watchdog_fired',
  phase: 'resume_watchdog',
  op: 'applock_resume',
  timeoutMs: APPLOCK_PROMPT_TIMEOUT_MS,
};

/** Cold-start or manual-retry prompt hung. Also stays locked. */
const PROMPT_WATCHDOG: AppLockTelemetry = {
  message: 'applock_prompt_watchdog_fired',
  phase: 'prompt_watchdog',
  op: 'applock_prompt',
  timeoutMs: APPLOCK_PROMPT_TIMEOUT_MS,
};

/**
 * Resume probe timed out with no prior knowledge that a lock exists. Fails
 * open, so it is reported at its own name rather than borrowing a watchdog
 * name that means "stayed locked".
 */
const RESUME_PROBE_UNKNOWN: AppLockTelemetry = {
  message: 'applock_resume_probe_unknown',
  phase: 'resume_watchdog',
  op: 'applock_resume_probe',
  timeoutMs: APPLOCK_PROBE_TIMEOUT_MS,
};

export function decideAfterProbe(
  path: 'init' | 'resume',
  cached: BgLockState,
  outcome: ProbeOutcome,
): ProbeDecision {
  if (outcome.kind === 'resolved') {
    const gateOn = outcome.available && outcome.enabled;
    if (gateOn) {
      return { action: 'prompt', bgLock: 'on', telemetry: null };
    }
    // Biometric lock is provably not configured (or was turned off while we
    // were backgrounded). Unlock without prompting.
    return {
      action: 'settle',
      locked: false,
      ready: true,
      bgLock: 'off',
      hint: null,
      telemetry: null,
    };
  }

  if (path === 'init') {
    // Fail open — see INIT_WATCHDOG. `bgLock` is deliberately left at its
    // cached value rather than forced to 'off': arming it 'on' would prompt
    // users who never enabled the lock, and forcing 'off' is the disarm bug.
    return {
      action: 'settle',
      locked: false,
      ready: true,
      bgLock: cached,
      hint: null,
      telemetry: INIT_WATCHDOG,
    };
  }

  // Resume, probe unusable. If a previous successful probe proved a lock is
  // configured, that prior knowledge stands and we go to the prompt.
  if (cached === 'on') {
    return { action: 'prompt', bgLock: 'on', telemetry: null };
  }

  // We never established that a lock exists. Prompting here could strand a
  // non-biometric user behind a lock screen they can never satisfy — the
  // biometric setting lives in Settings, which is behind this very guard.
  return {
    action: 'settle',
    locked: false,
    ready: true,
    bgLock: cached,
    hint: null,
    telemetry: RESUME_PROBE_UNKNOWN,
  };
}

export function decideAfterPrompt(
  path: LockPath,
  outcome: PromptOutcome,
): PromptDecision {
  if (outcome === 'success') {
    return { locked: false, hint: null, telemetry: null };
  }

  if (outcome === 'rejected') {
    // Without a hint the lock screen gives no feedback at all, just the same
    // Unlock button.
    return { locked: true, hint: APP_LOCK_COPY.cancelled, telemetry: null };
  }

  return {
    locked: true,
    hint: APP_LOCK_COPY.sensorUnavailable,
    telemetry: path === 'resume' ? RESUME_WATCHDOG : PROMPT_WATCHDOG,
  };
}

/**
 * Coarse-watchdog outcome, for the case where even `withPromiseTimeout` did not
 * recover the UI. It releases the spinner and the re-entrancy ref so the Unlock
 * button works again, and — on the resume path — deliberately leaves `locked`
 * alone rather than flipping it false.
 */
export function decideCoarseWatchdog(path: 'init' | 'resume'): {
  readonly releaseAuthenticating: true;
  readonly locked: boolean | null;
  readonly ready: boolean;
  readonly hint: string | null;
  readonly telemetry: AppLockTelemetry;
} {
  if (path === 'init') {
    return {
      releaseAuthenticating: true,
      locked: false,
      ready: true,
      hint: null,
      telemetry: INIT_WATCHDOG,
    };
  }
  return {
    releaseAuthenticating: true,
    // null = leave `isLocked` as it is. The resume path already set it true
    // before its first await, and a timer must not undo that.
    locked: null,
    ready: true,
    hint: APP_LOCK_COPY.sensorUnavailable,
    telemetry: RESUME_WATCHDOG,
  };
}

/**
 * Which half of a path to hang. The probe and the prompt have different
 * deadlines and OPPOSITE fail directions, so they must be armable separately —
 * keying the failpoint on the path alone would let the probe consume the
 * one-shot and leave the prompt branch permanently unreachable.
 */
export type LockStage = 'probe' | 'prompt';

export type LockFailpoint = `${LockPath}:${LockStage}`;

const LOCK_PATHS: readonly LockPath[] = ['init', 'resume', 'manual'];
const LOCK_STAGES: readonly LockStage[] = ['probe', 'prompt'];

export function isLockFailpoint(value: unknown): value is LockFailpoint {
  if (typeof value !== 'string') return false;
  const [path, stage] = value.split(':');
  return (
    LOCK_PATHS.includes(path as LockPath) &&
    LOCK_STAGES.includes(stage as LockStage)
  );
}

let nextDevelopmentHang: LockFailpoint | null = null;

/**
 * One-shot development diagnostic, mirroring `armNativePreflightHang` in
 * `src/lib/nativePreflight.ts`. The `__DEV__` branch is removed from release
 * bundles and no build-time flag can re-arm it after a restart.
 *
 * It exists because the release-blocker check in `docs/rn-sdk-upgrade-plan.md`
 * needs a real HANG, and cancelling a prompt cannot produce one.
 *
 * Example: `armAppLockHang('resume:prompt')`.
 */
export function armAppLockHang(failpoint: LockFailpoint): boolean {
  if (!__DEV__ || !isLockFailpoint(failpoint)) return false;
  nextDevelopmentHang = failpoint;
  return true;
}

export function clearAppLockHang(): void {
  nextDevelopmentHang = null;
}

export function getArmedAppLockHang(): LockFailpoint | null {
  return __DEV__ ? nextDevelopmentHang : null;
}

export function consumeAppLockHang(failpoint: LockFailpoint): boolean {
  if (!__DEV__ || nextDevelopmentHang !== failpoint) return false;
  nextDevelopmentHang = null;
  return true;
}
