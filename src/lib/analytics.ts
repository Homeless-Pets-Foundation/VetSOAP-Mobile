import PostHog from 'posthog-react-native';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { POSTHOG_KEY, POSTHOG_HOST } from '../config';

/**
 * PostHog analytics wrapper with a strict whitelist of event names and
 * property shapes. PHI is never allowed — the property types below are the
 * only fields we emit. If you need a new field, add it here, not inline.
 */

let _client: PostHog | null = null;

// Lazy so old dev-client APKs without the expo-application native module
// don't throw at module-load. See CLAUDE.md rule 23.
function getAppVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Application = require('expo-application') as typeof import('expo-application');
    return Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? 'unknown';
  } catch {
    return Constants.expoConfig?.version ?? 'unknown';
  }
}

const PLATFORM = Platform.OS;

// ─── Event catalog ─────────────────────────────────────────────────
//
// Every event name + property shape the app can emit. If it's not here, it
// doesn't get sent. Keep this small and PHI-free.

export type AnalyticsEvent =
  | { name: 'session_start'; props: Record<string, never> }
  | { name: 'session_signed_in'; props: { auth_method: 'password' | 'google' | 'apple' } }
  | { name: 'session_signed_out'; props: { trigger: 'user' | 'device_revoked' | 'session_expired' } }
  | { name: 'recording_started'; props: { slot_index: number } }
  | { name: 'recording_paused'; props: { slot_index: number; duration_s: number } }
  | { name: 'recording_resumed'; props: { slot_index: number } }
  | { name: 'recording_finished'; props: { slot_index: number; duration_s: number; segment_count: number } }
  | { name: 'recording_discarded'; props: { slot_index: number } }
  | { name: 'submit_attempted'; props: { slot_index: number; segment_count: number; duration_s: number; recording_id?: string; attempt_number: number; network_state: NetworkState } }
  | { name: 'submit_succeeded'; props: { slot_index: number; segment_count: number; duration_s: number; size_bytes: number; recording_id: string; attempt_number: number; latency_ms: number } }
  | { name: 'submit_failed'; props: { slot_index: number; segment_count: number; duration_s: number; recording_id?: string; attempt_number: number; error_phase: ErrorPhase; error_code: string; network_state: NetworkState; latency_ms: number } }
  | { name: 'stash_saved'; props: { slot_count: number } }
  | { name: 'stash_resumed'; props: { slot_count: number } }
  | { name: 'stash_discarded'; props: { slot_count: number } }
  | { name: 'submit_all_attempted'; props: { slot_count: number } }
  | { name: 'submit_all_completed'; props: { slot_count: number; success_count: number; failure_count: number } };

export type NetworkState = 'wifi' | 'cellular' | 'none' | 'unknown';

export type ErrorPhase =
  | 'unknown'
  | 'silent_check'
  | 'presign'
  | 'r2_put'
  | 'confirm'
  | 'create_draft'
  | 'patch_draft'
  | 'delete_draft'
  | 'stash_write'
  | 'stash_read';

/**
 * Initialize PostHog. Safe to call multiple times — idempotent.
 * No-op if key is not configured.
 */
export function initAnalytics(): void {
  if (_client) return;
  if (!POSTHOG_KEY) {
    if (__DEV__) console.log('[PostHog] Disabled — EXPO_PUBLIC_POSTHOG_KEY not set');
    return;
  }

  try {
    _client = new PostHog(POSTHOG_KEY, {
      host: POSTHOG_HOST,
      // Disable autocapture — we only want explicit events we can audit.
      captureAppLifecycleEvents: false,
      // Disable navigation autocapture — screen names would leak PHI.
      captureNativeAppLifecycleEvents: false,
      flushAt: 20,
      flushInterval: 10_000,
      // No session replay. No screen capture. Ever. (PHI.)
      enableSessionReplay: false,
      persistence: 'file',
    } as ConstructorParameters<typeof PostHog>[1]);

    // Super-properties attached to every event.
    _client.register({
      app_version: getAppVersion(),
      platform: PLATFORM,
      ...(__DEV__ ? { build_env: 'development' } : { build_env: 'production' }),
    });

    if (__DEV__) console.log('[PostHog] Initialized');
  } catch (error) {
    // Never let analytics init crash the app — rule 1.
    if (__DEV__) console.error('[PostHog] Init failed', error);
    _client = null;
  }
}

/** Identify the signed-in user. No email, no name — user_id only. */
export function identifyUser(userId: string, organizationId?: string): void {
  if (!_client) return;
  try {
    _client.identify(userId);
    if (organizationId) {
      _client.group('organization', organizationId);
    }
  } catch {
    // swallow
  }
}

/** Reset analytics identity on sign-out. */
export function resetAnalytics(): void {
  if (!_client) return;
  try {
    _client.reset();
  } catch {
    // swallow
  }
}

/**
 * Emit a whitelisted analytics event. The discriminated union above is
 * enforced at the type level — callers can't pass arbitrary payloads.
 */
export function trackEvent<E extends AnalyticsEvent>(event: E): void {
  if (!_client) return;
  try {
    // Strip `undefined` — PostHog's JsonType rejects it. `null` is fine.
    const cleaned: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(event.props as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        cleaned[k] = v;
      }
    }
    _client.capture(event.name, cleaned);
  } catch {
    // swallow
  }
}

/** Flush pending events. Call from handleSignOut before clearing user. */
export async function flushAnalytics(): Promise<void> {
  if (!_client) return;
  try {
    await _client.flush();
  } catch {
    // swallow
  }
}
