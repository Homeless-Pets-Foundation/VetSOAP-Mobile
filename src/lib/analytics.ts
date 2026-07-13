import type PostHog from 'posthog-react-native';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { POSTHOG_KEY, POSTHOG_HOST } from '../config';
import { shouldEmit, getSuppressionSummary } from './rateLimitMonitoring';

/**
 * PostHog analytics wrapper with a strict whitelist of event names and
 * property shapes. PHI is never allowed — the property types below are the
 * only fields we emit. If you need a new field, add it here, not inline.
 */

// Lazy so old dev-client APKs without posthog-react-native's native deps
// (expo-application etc.) don't throw at module-load. See CLAUDE.md rule 23.
let _PostHog: any | null = null;
function loadPostHog(): typeof PostHog | null {
  if (_PostHog) return _PostHog;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _PostHog = require('posthog-react-native').default;
    return _PostHog;
  } catch {
    return null;
  }
}

let _client: PostHog | null = null;

// initAnalytics() is deferred off the cold-start critical path (called after
// the first frame in RootLayout). Events fired before it runs — including
// AuthProvider's startup events, whose effects run before RootLayout's — are
// queued here and drained on init. Bounded drop-oldest so a pre-init error
// storm can't grow memory; nulled once init resolves (success or failure) so
// the steady state has no queue overhead.
const PRE_INIT_QUEUE_CAP = 50;
let _preInitQueue: AnalyticsEvent[] | null = [];

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

// Lazy so old dev-client APKs without expo-device don't crash at load.
function getDeviceModel(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Device = require('expo-device') as typeof import('expo-device');
    return Device.modelName ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const PLATFORM = Platform.OS;

// ─── Event catalog ─────────────────────────────────────────────────
//
// Every event name + property shape the app can emit. If it's not here, it
// doesn't get sent. Keep this small and PHI-free.

export type SubmitDiagnosticsProps = {
  slot_count: number;
  has_existing_server_draft: boolean;
  has_pending_confirm: boolean;
  draft_metadata_dirty: boolean;
  confirm_used_atomic_metadata_update: boolean;
  stale_draft_promotion_blocked: boolean;
  species_present: boolean;
  breed_present: boolean;
  appointment_type_present: boolean;
  client_last_name_present: boolean;
};

export type AnalyticsEvent =
  // Session + auth
  | { name: 'session_start'; props: { cold_start_ms?: number } }
  | { name: 'session_signed_in'; props: { auth_method: 'password' | 'google' | 'apple' } }
  | { name: 'session_signed_out'; props: { trigger: 'user' | 'device_revoked' | 'session_expired' } }
  | { name: 'sign_in_attempted'; props: { auth_method: 'password' | 'google' | 'apple' } }
  | { name: 'sign_in_failed'; props: { auth_method: 'password' | 'google' | 'apple'; error_code: string; retry_used: boolean } }
  | { name: 'auth_retry_fired'; props: { op: 'sign_in' | 'refresh_session' } }
  | { name: 'session_refresh_attempted'; props: { trigger: RefreshTrigger } }
  | { name: 'session_refresh_failed'; props: { trigger: RefreshTrigger; error_code: string } }
  | { name: 'mfa_step_up_required'; props: { reason: string; current_level: string; next_level: string } }
  | { name: 'device_registration_failed'; props: { error_code: string } }
  // Recording lifecycle
  | { name: 'recording_started'; props: { slot_index: number } }
  | { name: 'recording_started_blank_fields'; props: { blank_field_count: number } }
  | { name: 'recording_paused'; props: { slot_index: number; duration_s: number } }
  | { name: 'recording_resumed'; props: { slot_index: number } }
  | { name: 'recording_finished'; props: { slot_index: number; duration_s: number; segment_count: number } }
  | { name: 'recording_discarded'; props: { slot_index: number } }
  | { name: 'recording_background_flush_requested'; props: { slot_index: number; segment_count: number; duration_s: number } }
  | { name: 'template_selected'; props: { template_kind: string } }
  | { name: 'audio_quality_measured'; props: { slot_index: number; duration_s: number; size_bytes: number; kbps_estimated: number; segment_count: number } }
  | { name: 'audio_bitrate_anomaly'; props: { slot_index: number; duration_s: number; size_bytes: number; kbps_estimated: number; expected_min: number; expected_max: number } }
  | { name: 'audio_silence_check_inconclusive'; props: { slot_index: number; duration_s: number; segment_count: number; reason: SilenceCheckInconclusiveReason } }
  | { name: 'silent_check_bypassed'; props: { slot_index: number; duration_s: number; segment_count: number; reason: SilenceCheckSilentReason } }
  // Submit
  | { name: 'submit_attempted'; props: { slot_index: number; segment_count: number; duration_s: number; recording_id?: string; attempt_number: number; network_state: NetworkState } & SubmitDiagnosticsProps }
  | { name: 'submit_succeeded'; props: { slot_index: number; segment_count: number; duration_s: number; size_bytes: number; recording_id: string; attempt_number: number; latency_ms: number } & SubmitDiagnosticsProps }
  | { name: 'submit_failed'; props: { slot_index: number; segment_count: number; duration_s: number; recording_id?: string; attempt_number: number; error_phase: ErrorPhase; error_code: string; network_state: NetworkState; latency_ms: number } & SubmitDiagnosticsProps }
  | { name: 'upload_stale_recording_recovery'; props: { stage: string; outcome: string; attempt: 1; segment_count: number; mode: 'durable' | 'standard' } }
  | { name: 'submit_all_attempted'; props: { slot_count: number } }
  | { name: 'submit_all_completed'; props: { slot_count: number; success_count: number; failure_count: number } }
  // Stash + draft
  | { name: 'stash_saved'; props: { slot_count: number } }
  | { name: 'stash_resumed'; props: { slot_count: number } }
  | { name: 'stash_discarded'; props: { slot_count: number } }
  | { name: 'recording_auto_stashed'; props: { reason: AutoStashReason; slot_index: number; segment_count: number; duration_s: number } }
  | { name: 'stash_write_failed'; props: { reason: FailureReason } }
  | { name: 'draft_save_failed'; props: { reason: FailureReason } }
  | { name: 'draft_sync_retry_failed'; props: { attempt_number: number } }
  | { name: 'draft_orphan_sweep'; props: { found: number; deleted: number } }
  | { name: 'draft_save_segment_copy_failed'; props: { expected: number; saved: number; ensure_dir_failed: boolean; reasons: string; prior_valid_save: boolean } }
  // Durable recorder (crash-recovery capture). All PHI-free.
  | { name: 'durable_recorder_started'; props: { slot_index: number; sample_rate: number; bitrate: number } }
  | { name: 'durable_commit_flushed'; props: { committed_through_ms: number; frame_count: number } }
  | { name: 'durable_commit_lagged'; props: { lag_ms: number } }
  | { name: 'durable_recorder_interrupted'; props: { reason: string } }
  | { name: 'durable_resume_failed'; props: { error_code: string } }
  | { name: 'durable_writer_backpressure'; props: { queue_ms?: number } }
  | { name: 'durable_capture_drop'; props: { dropped_frames?: number } }
  | { name: 'durable_process_recovered'; props: { recovered_count: number } }
  | { name: 'durable_battery_opt_exemption'; props: { granted: boolean } }
  | { name: 'durable_recovery_available'; props: { count: number } }
  | { name: 'durable_recovery_restored'; props: { mode: 'resume' | 'review' | 'stash' } }
  | { name: 'durable_recovery_discarded'; props: Record<string, never> }
  | { name: 'durable_recorder_unavailable'; props: { reason: string } }
  | { name: 'durable_upload_confirmed'; props: { recording_id?: string } }
  | { name: 'durable_adts_parse_error'; props: { reason: string } }
  | { name: 'durable_aac_size_warning'; props: { size_bytes: number } }
  | { name: 'durable_aac_size_stop'; props: { size_bytes: number } }
  | { name: 'durable_aac_oversize_recovered'; props: { size_bytes: number } }
  | { name: 'durable_recorder_op_watchdog'; props: { op: 'start' | 'pause' | 'resume' | 'stop' | 'scan' } }
  | { name: 'durable_low_space_stop'; props: { free_bytes?: number } }
  // API + network
  | { name: 'api_request_failed'; props: { endpoint_kind: EndpointKind; status: number; latency_ms: number; retried: boolean } }
  // Startup resilience
  | { name: 'profile_cache_used'; props: { age_s: number } }
  // Recording detail (transcript + playback)
  | { name: 'transcript_viewed'; props: { recording_id: string } }
  | { name: 'audio_playback_started'; props: { recording_id: string } }
  | { name: 'audio_playback_failed'; props: { recording_id: string; error_code: string } }
  // SOAP
  | { name: 'soap_visible'; props: { recording_id: string; ms_since_finish: number | null; ms_since_submit: number | null } }
  | { name: 'soap_section_edited'; props: { recording_id: string; section: SoapSectionName } }
  | { name: 'soap_exported'; props: { target: SoapExportTarget; recording_id: string } }
  | { name: 'soap_regenerated'; props: { recording_id: string; template_changed: boolean } }
  | { name: 'recording_reprocessed'; props: {
      recording_id: string;
      transcription_model: string;
      soap_model: string;
      transcription_model_changed: boolean;
      soap_model_changed: boolean;
    } }
  | { name: 'email_draft_generated'; props: { recording_id: string } }
  | { name: 'soap_translated'; props: { recording_id: string; target_language: TranslationTargetLanguage } }
  | { name: 'suggested_task_resolved'; props: { action: 'accepted' | 'dismissed'; type: 'todo' | 'billing' } }
  | { name: 'template_default_set'; props: { template_kind: string } }
  | { name: 'ai_metadata_review_shown'; props: { applied_field_count: number } }
  | {
      name: 'ai_metadata_extraction_observed';
      props: {
        applied_field_count: number;
        suggested_field_count: number;
        extracted_field_count: number;
        multiple_patients_detected: boolean;
        had_metadata: boolean;
        needs_metadata_review: boolean;
        blank_field_count_at_submit: number;
        drop_reasons_count?: number;
      };
    }
  | { name: 'ai_metadata_review_resolved'; props: { action: 'confirmed' | 'corrected' | 'dismissed'; corrected_field_count: number } }
  // Account surface
  | { name: 'profile_updated'; props: { fields: string } }
  | { name: 'subscription_viewed'; props: { status: string } }
  | { name: 'support_link_opened'; props: { link: 'help_center' | 'contact' } }
  | { name: 'account_deletion_requested'; props: Record<string, never> }
  // Billing
  | { name: 'trial_limit_hit'; props: Record<string, never> }
  | { name: 'byok_key_failed'; props: { model_provider: 'openai' | 'anthropic' | 'google' } }
  // Biometric
  | { name: 'biometric_prompt_shown'; props: Record<string, never> }
  | { name: 'biometric_result'; props: { result: 'success' | 'cancel' | 'lockout' | 'hw_error' | 'not_enrolled' } }
  // Permissions + device
  | { name: 'permissions_snapshot'; props: { mic: PermissionState; notifications: PermissionState } }
  | { name: 'mic_permission_denied'; props: { can_ask_again: boolean } }
  | { name: 'app_state_change'; props: { from: AppStateValue; to: AppStateValue; during: 'record' | 'upload' | 'idle' } }
  // Observability of observability
  | { name: 'monitoring_suppression_summary'; props: { total_suppressed: number; top_key: string | null; top_count: number; active_buckets: number } };

export type NetworkState = 'wifi' | 'cellular' | 'none' | 'unknown';

export type RefreshTrigger = 'recovery' | 'foreground' | 'on_auth_state' | 'device_registration' | 'manual';

export type FailureReason = 'secure_store' | 'fs' | 'quota' | 'network' | 'other';

export type AutoStashReason = 'r2_put_dead_network' | 'create_draft_dead_network';

export type SilenceCheckInconclusiveReason = 'missing_metering_long_recording' | 'ffmpeg_timeout' | 'ffmpeg_error';

export type SilenceCheckSilentReason = 'metering_all_below_threshold' | 'ffmpeg_all_segments_silent';

export type EndpointKind = 'recordings' | 'auth' | 'telemetry' | 'devices' | 'soap' | 'other';

export type SoapExportTarget = 'clipboard' | 'pims' | 'share_sheet' | 'email' | 'pdf';

export type TranslationTargetLanguage = 'Spanish' | 'French' | 'Portuguese' | 'custom';

export type SoapSectionName = 'subjective' | 'objective' | 'assessment' | 'plan';

export type PermissionState = 'granted' | 'denied' | 'undetermined';

export type AppStateValue = 'active' | 'background' | 'inactive' | 'unknown';

export type ErrorPhase =
  | 'unknown'
  | 'preflight'
  | 'silent_check'
  | 'ai_extract'
  | 'presign'
  | 'r2_put'
  | 'confirm'
  | 'create_draft'
  | 'patch_draft'
  | 'prepare'
  | 'probe'
  | 'delete_draft'
  | 'stash_write'
  | 'stash_read'
  | 'recorder_start'
  | 'recorder_pause'
  | 'recorder_resume'
  | 'recorder_stop'
  | 'recorder_status'
  | 'auth_sign_in'
  | 'auth_refresh'
  | 'auth_register_device'
  | 'secure_store_read'
  | 'secure_store_write'
  | 'biometric'
  | 'draft_save'
  | 'draft_sync'
  | 'ssl_pin_violation'
  | 'api_request';

/**
 * Initialize PostHog. Safe to call multiple times — idempotent.
 * No-op if key is not configured.
 */
export function initAnalytics(): void {
  if (_client) return;
  if (!POSTHOG_KEY) {
    _preInitQueue = null;
    if (__DEV__) console.log('[PostHog] Disabled — EXPO_PUBLIC_POSTHOG_KEY not set');
    return;
  }

  const PostHogCtor = loadPostHog();
  if (!PostHogCtor) {
    _preInitQueue = null;
    if (__DEV__) console.log('[PostHog] Disabled — posthog-react-native native module unavailable');
    return;
  }

  try {
    _client = new PostHogCtor(POSTHOG_KEY, {
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
      device_model: getDeviceModel(),
      ...(__DEV__ ? { build_env: 'development' } : { build_env: 'production' }),
    });

    // Kick off the periodic suppression-summary timer. This is the only
    // signal that tells us when the rate limiter is masking a bug.
    startSuppressionSummaryTimer();

    // Drain events that fired before init — through the normal gate so a
    // pre-init retry storm still can't drain PostHog quota.
    const queued = _preInitQueue;
    _preInitQueue = null;
    if (queued) {
      for (const event of queued) emitEvent(event);
    }

    if (__DEV__) console.log('[PostHog] Initialized');
  } catch (error) {
    // Never let analytics init crash the app — rule 1.
    if (__DEV__) console.error('[PostHog] Init failed', error);
    _client = null;
    _preInitQueue = null;
  }
}

const SUPPRESSION_SUMMARY_INTERVAL_MS = 5 * 60 * 1000;
let _suppressionTimer: ReturnType<typeof setInterval> | null = null;

function startSuppressionSummaryTimer(): void {
  if (_suppressionTimer) return;
  _suppressionTimer = setInterval(() => {
    const summary = getSuppressionSummary();
    if (summary.totalSuppressed === 0) return;
    // Bypass the rate limiter for this specific event — it's the instrument
    // that reports on the rate limiter itself. If this spams, something is
    // very wrong and we want to see it.
    if (!_client) return;
    try {
      _client.capture('monitoring_suppression_summary', {
        total_suppressed: summary.totalSuppressed,
        top_key: summary.topKey,
        top_count: summary.topCount,
        active_buckets: summary.activeBuckets,
      });
    } catch {
      // swallow
    }
  }, SUPPRESSION_SUMMARY_INTERVAL_MS);
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
 * Build the rate-limiter sub-key for an event. Intentionally coarse: use
 * only the fields that represent the "kind" of occurrence, never recording_id
 * or slot_index. See `rateLimitMonitoring.ts` for rationale.
 */
function subKeyForEvent(event: AnalyticsEvent): string {
  const p = event.props as Record<string, unknown>;
  const parts: string[] = [event.name];
  const error_code = typeof p.error_code === 'string' ? p.error_code : undefined;
  const error_phase = typeof p.error_phase === 'string' ? p.error_phase : undefined;
  const reason = typeof p.reason === 'string' ? p.reason : undefined;
  const trigger = typeof p.trigger === 'string' ? p.trigger : undefined;
  const endpoint_kind = typeof p.endpoint_kind === 'string' ? p.endpoint_kind : undefined;
  const status = typeof p.status === 'number' ? String(p.status) : undefined;
  const auth_method = typeof p.auth_method === 'string' ? p.auth_method : undefined;
  const discriminator = error_code ?? error_phase ?? reason ?? trigger ?? endpoint_kind ?? auth_method ?? status ?? 'none';
  parts.push(discriminator);
  if (endpoint_kind && status) parts.push(status);
  return parts.join(':');
}

/**
 * Emit a whitelisted analytics event. The discriminated union above is
 * enforced at the type level — callers can't pass arbitrary payloads. Rate
 * limiter wraps the emission so a retry loop can't drain PostHog quota.
 */
export function trackEvent<E extends AnalyticsEvent>(event: E): void {
  if (!_client) {
    // Pre-init window: hold the event for the drain in initAnalytics().
    // The rate-limit gate runs at drain time, not here.
    if (_preInitQueue) {
      if (_preInitQueue.length >= PRE_INIT_QUEUE_CAP) _preInitQueue.shift();
      _preInitQueue.push(event);
    }
    return;
  }
  emitEvent(event);
}

function emitEvent(event: AnalyticsEvent): void {
  if (!_client) return;
  const gate = shouldEmit('track_event', subKeyForEvent(event));
  if (!gate.emit) return;
  try {
    // Strip `undefined` — PostHog's JsonType rejects it. `null` is fine.
    const cleaned: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(event.props as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        cleaned[k] = v;
      }
    }
    if (gate.suppressedPriorWindow > 0) {
      cleaned.suppressed_prior_window = gate.suppressedPriorWindow;
    }
    _client.capture(event.name, cleaned);
  } catch {
    // swallow
  }
}

let _flushFailureStreak = 0;
const FLUSH_FAILURE_THRESHOLD = 3;

/** Flush pending events. Call from handleSignOut before clearing user. */
export async function flushAnalytics(): Promise<void> {
  if (!_client) return;
  try {
    await _client.flush();
    _flushFailureStreak = 0;
  } catch (error) {
    _flushFailureStreak += 1;
    if (_flushFailureStreak === FLUSH_FAILURE_THRESHOLD) {
      // Report once per streak threshold; further failures are silent until
      // a clean flush resets the streak. Rate limiter on the Sentry side
      // stops this from escalating further if the flush target itself is
      // the thing that's broken.
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { captureMessage } = require('./monitoring') as typeof import('./monitoring');
        captureMessage('posthog_flush_failed', 'warning', {
          extra: { streak: _flushFailureStreak, last_error: String(error).slice(0, 200) },
        });
      } catch {
        // swallow
      }
    }
  }
}
