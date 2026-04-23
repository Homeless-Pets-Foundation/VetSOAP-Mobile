/**
 * Client-side rate limiter for monitoring emissions.
 *
 * Every outbound monitoring call (Sentry `captureException`, PostHog
 * `trackEvent`, server `reportClientError`, etc.) funnels through here. The
 * goal is to stop a retry-loop bug from burning Sentry/PostHog quota or
 * blowing up `client_telemetry` with thousands of identical rows while still
 * letting novel errors through immediately.
 *
 * Design (locked in by the 2026-04-22 plan):
 *   - Fixed-window counter. 60s window.
 *   - Per-channel cap. See `CHANNEL_CAPS` below.
 *   - Key cardinality kept coarse: `${channel}::${subKey}` where `subKey`
 *     is a short string like `${event_name}:${error_code}`. Never include
 *     recording_id, slot_index, or user_id — that defeats the limiter.
 *   - First event of a new window always emits and carries the prior
 *     window's suppressed count so dashboards can show the true rate.
 *   - In-memory only. Cold-start reset is a feature — novel errors after
 *     restart always get fresh budget.
 */

export type RateLimitChannel =
  | 'report_client_error'
  | 'track_event'
  | 'capture_exception'
  | 'capture_message_warning';

const CHANNEL_CAPS: Record<RateLimitChannel, number> = {
  report_client_error: 5,
  track_event: 5,
  capture_exception: 20,
  capture_message_warning: 3,
};

const WINDOW_MS = 60_000;

interface Bucket {
  count: number;
  start: number;
  suppressed: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  emit: boolean;
  /**
   * Count of events suppressed during the immediately-preceding window for
   * this bucket. Non-zero only on the first event of a fresh window, which
   * is when the caller should attach it as `extra.suppressed_prior_window`.
   */
  suppressedPriorWindow: number;
}

function bucketKey(channel: RateLimitChannel, subKey: string): string {
  return `${channel}::${subKey}`;
}

/**
 * Check whether an emission should be allowed through. Callers should use
 * `result.emit` to gate the actual SDK call, and attach
 * `result.suppressedPriorWindow` (when > 0) to the emitted payload so
 * downstream dashboards can see the true rate instead of the capped rate.
 */
export function shouldEmit(channel: RateLimitChannel, subKey: string): RateLimitResult {
  const now = Date.now();
  const key = bucketKey(channel, subKey);
  const cap = CHANNEL_CAPS[channel];
  const existing = buckets.get(key);

  if (!existing) {
    buckets.set(key, { count: 1, start: now, suppressed: 0 });
    return { emit: true, suppressedPriorWindow: 0 };
  }

  if (now - existing.start > WINDOW_MS) {
    const suppressedPrior = existing.suppressed;
    existing.count = 1;
    existing.start = now;
    existing.suppressed = 0;
    return { emit: true, suppressedPriorWindow: suppressedPrior };
  }

  if (existing.count >= cap) {
    existing.suppressed += 1;
    return { emit: false, suppressedPriorWindow: 0 };
  }

  existing.count += 1;
  return { emit: true, suppressedPriorWindow: 0 };
}

export interface SuppressionSummary {
  totalSuppressed: number;
  topKey: string | null;
  topCount: number;
  activeBuckets: number;
}

/**
 * Snapshot of current suppression state across every bucket. Designed to be
 * emitted periodically (e.g. every 5 minutes) as a PostHog event so
 * "is monitoring being spammed?" is itself observable. Does not reset the
 * counters — natural window expiry handles that.
 */
export function getSuppressionSummary(): SuppressionSummary {
  let totalSuppressed = 0;
  let topKey: string | null = null;
  let topCount = 0;
  for (const [key, b] of buckets.entries()) {
    totalSuppressed += b.suppressed;
    if (b.suppressed > topCount) {
      topCount = b.suppressed;
      topKey = key;
    }
  }
  return {
    totalSuppressed,
    topKey,
    topCount,
    activeBuckets: buckets.size,
  };
}

/** Test-only: drop all buckets. Do not call from production code paths. */
export function __resetRateLimiterForTest(): void {
  buckets.clear();
}
