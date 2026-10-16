/**
 * Foreground-only elapsed time.
 *
 * Android suspends the JS thread while the app is in the background, but every
 * clock keeps counting, so a request started just before the user switched
 * apps reported the whole absence as latency. Clinic tablets get backgrounded
 * mid-request all the time, which turned ordinary requests into multi-second
 * "slow request" signals the server never saw.
 *
 * One AppState subscription per process accumulates the milliseconds spent
 * outside `active`; a timer subtracts the share that fell inside its own span.
 * The clock is local rather than `monitoring.nowMs` so the API client's import
 * graph stays free of the Sentry SDK (monitoring is required lazily there).
 */
import { AppState, type AppStateStatus } from 'react-native';

function monotonicNowMs(): number {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
  } catch {
    // Fall back below.
  }
  return Date.now();
}

let subscribed = false;
let backgroundStartedAt: number | null = null;
let accumulatedBackgroundMs = 0;
/** Bumped on every departure from `active`, so a timer can tell it was suspended. */
let departures = 0;

function onAppStateChange(state: AppStateStatus): void {
  const now = monotonicNowMs();
  if (state === 'active') {
    if (backgroundStartedAt !== null) {
      accumulatedBackgroundMs += now - backgroundStartedAt;
      backgroundStartedAt = null;
    }
    return;
  }
  if (backgroundStartedAt === null) {
    backgroundStartedAt = now;
    departures += 1;
  }
}

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  try {
    if (AppState.currentState && AppState.currentState !== 'active') {
      backgroundStartedAt = monotonicNowMs();
      departures += 1;
    }
    AppState.addEventListener('change', onAppStateChange);
  } catch {
    // Without AppState the timer degrades to plain elapsed time.
  }
}

/** Background milliseconds since process start, including a running absence. */
function backgroundMsAt(now: number): number {
  return accumulatedBackgroundMs + (backgroundStartedAt === null ? 0 : now - backgroundStartedAt);
}

export interface ForegroundTimer {
  /** Elapsed milliseconds since the timer started, excluding time in background. */
  elapsedForegroundMs(): number;
  /** Whether the app left `active` at any point since the timer started. */
  wasSuspended(): boolean;
}

export function startForegroundTimer(): ForegroundTimer {
  ensureSubscribed();
  const startedAt = monotonicNowMs();
  const backgroundAtStart = backgroundMsAt(startedAt);
  const departuresAtStart = departures;
  const startedInBackground = backgroundStartedAt !== null;
  return {
    elapsedForegroundMs() {
      const now = monotonicNowMs();
      const background = backgroundMsAt(now) - backgroundAtStart;
      return Math.max(0, now - startedAt - background);
    },
    wasSuspended() {
      return startedInBackground || departures !== departuresAtStart;
    },
  };
}
