import * as Sentry from '@sentry/react-native';
import { AppState, DeviceEventEmitter, Platform } from 'react-native';
import Constants from 'expo-constants';
import { SENTRY_DSN } from '../config';
import { shouldEmit } from './rateLimitMonitoring';

/**
 * Sentry wrapper. All API here must be safe to call when Sentry is disabled
 * (no DSN configured) — this is load-bearing for CLAUDE.md rule 1: never
 * throw at module load. If `init()` never runs, the `@sentry/react-native`
 * SDK functions become silent no-ops, which matches what we want.
 *
 * PHI: `beforeSend` strips file paths, patient-shaped fields, and any stack
 * frames that include local file URIs. The server's route handler runs its
 * own scrub as defense-in-depth.
 */

let _initialized = false;

function scrub<T extends object>(obj: T): T {
  // Redact common PHI-adjacent keys in event extras / breadcrumb data.
  // This is string-replaced in place because Sentry's event object is a
  // nested grab-bag and a deep clone would bloat the hot path.
  const phiKeys = [
    'patient_name',
    'patientName',
    'client_name',
    'clientName',
    'species',
    'breed',
    'transcript',
    'transcriptText',
    'subjective',
    'objective',
    'assessment',
    'plan',
    'additionalNotes',
  ];
  for (const key of Object.keys(obj)) {
    const val = (obj as Record<string, unknown>)[key];
    if (phiKeys.includes(key) && typeof val === 'string') {
      (obj as Record<string, unknown>)[key] = '[redacted]';
    } else if (val && typeof val === 'object') {
      scrub(val as object);
    } else if (typeof val === 'string' && /file:\/\//i.test(val)) {
      (obj as Record<string, unknown>)[key] = val.replace(/file:\/\/[^\s'"]+/gi, 'file://[redacted]');
    }
  }
  return obj;
}

/**
 * Initialize Sentry. Safe to call multiple times — idempotent.
 * No-op if DSN is not configured.
 */
export function initMonitoring(): void {
  if (_initialized) return;
  if (!SENTRY_DSN) {
    if (__DEV__) console.log('[Sentry] Disabled — EXPO_PUBLIC_SENTRY_DSN not set');
    return;
  }

  try {
    // Lazy-load expo-application so old dev-client APKs built before this
    // dep was added don't crash on module-load. See CLAUDE.md rule 23.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Application = require('expo-application') as typeof import('expo-application');
    Sentry.init({
      dsn: SENTRY_DSN,
      // Release identifier so we can tie crashes to an app version.
      release: `${Application.applicationId ?? 'com.captivet.mobile'}@${Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? 'unknown'}+${Application.nativeBuildVersion ?? '0'}`,
      environment: __DEV__ ? 'development' : 'production',
      enabled: !__DEV__ || process.env.EXPO_PUBLIC_SENTRY_ENABLE_IN_DEV === 'true',
      // ApiClient.doFetch already emits `network/info` breadcrumbs with a
      // server-side request_id (the cross-reference key we want). Sentry's
      // default xhr capture writes a parallel `xhr/info` breadcrumb for the
      // same request, doubling every payload (Sentry REACT-NATIVE-4 event
      // showed every entry duplicated). Replace the default Breadcrumbs
      // integration with one that skips xhr/fetch capture.
      integrations: (defaults) => defaults.map((i) =>
        i.name === 'Breadcrumbs'
          ? Sentry.breadcrumbsIntegration({
              console: true,
              dom: false,
              fetch: false,
              history: false,
              sentry: true,
              xhr: false,
            })
          : i
      ),
      // Perf signals worth paying for: cold-start (`enableAppStartTracking`),
      // slow/frozen frames (`enableNativeFramesTracking`), JS-thread stalls
      // (`enableStallTracking`), and user interaction tracing — useful for
      // the open WatchdogTermination triage and to catch upload-path /
      // multi-patient pager regressions before users report them. Defaults
      // already enable most of these when `tracesSampler` is set, but pin
      // them explicitly so a future SDK default flip can't silently disable.
      enableAppStartTracking: true,
      enableNativeFramesTracking: true,
      enableStallTracking: true,
      enableUserInteractionTracing: true,
      // Release health — bucket session counts by app version for triage.
      enableAutoSessionTracking: true,
      // Sample more aggressively for upload-path transactions — that's the
      // code we actually care about tracing. Everything else stays at 10%.
      // Errors are always captured regardless.
      tracesSampler: (samplingContext) => {
        const op = samplingContext?.transactionContext?.op ?? '';
        const name = samplingContext?.transactionContext?.name ?? '';
        if (op === 'http.client' && (name.includes('/api/recordings') || name.includes('/api/telemetry'))) {
          return 1.0;
        }
        return 0.1;
      },
      // iOS app-hang tracking: watchdog-style detection when the main thread
      // stops responding. Android ANR detection is enabled through the native
      // SDK's default integrations but called out here for clarity.
      enableAppHangTracking: true,
      // Default PII off — we set user ID manually via setUser().
      sendDefaultPii: false,
      // Drop noisy breadcrumbs we don't need and scrub the rest.
      maxBreadcrumbs: 50,
      beforeBreadcrumb(breadcrumb) {
        if (breadcrumb.category === 'console' && breadcrumb.level === 'debug') {
          return null;
        }
        if (breadcrumb.data) {
          scrub(breadcrumb.data);
        }
        if (breadcrumb.message && /file:\/\//i.test(breadcrumb.message)) {
          breadcrumb.message = breadcrumb.message.replace(/file:\/\/[^\s'"]+/gi, 'file://[redacted]');
        }
        return breadcrumb;
      },
      beforeSend(event) {
        // Strip PHI from event body.
        if (event.extra) scrub(event.extra);
        if (event.contexts) scrub(event.contexts);
        if (event.tags) scrub(event.tags);
        // Redact file:// paths in exception messages and stack frames.
        if (event.exception?.values) {
          for (const ex of event.exception.values) {
            if (ex.value && /file:\/\//i.test(ex.value)) {
              ex.value = ex.value.replace(/file:\/\/[^\s'"]+/gi, 'file://[redacted]');
            }
            if (ex.stacktrace?.frames) {
              for (const frame of ex.stacktrace.frames) {
                if (frame.filename && /file:\/\//i.test(frame.filename)) {
                  frame.filename = frame.filename.replace(/file:\/\/[^\s'"]+/gi, 'file://[redacted]');
                }
              }
            }
          }
        }
        // Never send request bodies — they could contain form data.
        if (event.request) {
          delete event.request.data;
          delete event.request.cookies;
        }
        return event;
      },
    });

    Sentry.setTag('platform', Platform.OS);
    Sentry.setTag('app_version', Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? 'unknown');

    // iOS-only memory warning trail for the open WatchdogTermination triage.
    // RN core posts a `memoryWarning` event on DeviceEventEmitter when iOS
    // calls didReceiveMemoryWarning. Android has no equivalent without a
    // custom native module — out of scope.
    if (Platform.OS === 'ios') {
      DeviceEventEmitter.addListener('memoryWarning', () => {
        try {
          Sentry.addBreadcrumb({
            category: 'memory',
            message: 'ios_memory_warning',
            level: 'warning',
          });
        } catch { /* swallow */ }
      });
    }

    _initialized = true;
    if (__DEV__) console.log('[Sentry] Initialized');
  } catch (error) {
    // Never let Sentry init crash the app — rule 1.
    if (__DEV__) console.error('[Sentry] Init failed', error);
  }
}

/** Associate future events with the current user. No email, no PHI. */
export function setMonitoringUser(userId: string, organizationId?: string): void {
  if (!_initialized) return;
  try {
    Sentry.setUser({ id: userId });
    if (organizationId) Sentry.setTag('organization_id', organizationId);
  } catch {
    // swallow
  }
}

/** Clear user context on sign-out. */
export function clearMonitoringUser(): void {
  if (!_initialized) return;
  try {
    Sentry.setUser(null);
  } catch {
    // swallow
  }
}

export type BreadcrumbCategory =
  | 'auth'
  | 'record'
  | 'upload'
  | 'stash'
  | 'draft'
  | 'navigation'
  | 'network'
  | 'memory'
  | 'ffmpeg'
  | 'performance';

/** Record a breadcrumb. Safe to call even when Sentry is disabled. */
export function breadcrumb(
  category: BreadcrumbCategory,
  message: string,
  data?: Record<string, string | number | boolean | null | undefined>,
): void {
  if (!_initialized) return;
  try {
    Sentry.addBreadcrumb({
      category,
      message,
      level: 'info',
      data: data ?? undefined,
    });
  } catch {
    // swallow
  }
}

/**
 * Build a coarse rate-limiter sub-key from exception context. Prefers the
 * `phase` or `op` tag the caller passed (that's the semantic dedup key), then
 * the error's `name` or constructor, then a constant. Never keys on anything
 * high-cardinality like recording_id.
 */
function subKeyForException(error: unknown, tags?: Record<string, string>): string {
  const phase = tags?.phase;
  const op = tags?.op;
  const component = tags?.component;
  let errorName = 'Error';
  if (error && typeof error === 'object') {
    const maybeName = (error as { name?: unknown }).name;
    if (typeof maybeName === 'string' && maybeName.length > 0) errorName = maybeName;
  }
  return [phase ?? op ?? component ?? 'generic', errorName].join(':');
}

/** Capture a caught exception. Rate-limited per `${tag.phase | op | component}:${error.name}`. */
export function captureException(
  error: unknown,
  context?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
): string | undefined {
  if (!_initialized) return undefined;
  const gate = shouldEmit('capture_exception', subKeyForException(error, context?.tags));
  if (!gate.emit) return undefined;
  try {
    const extra = { ...(context?.extra ?? {}) };
    if (gate.suppressedPriorWindow > 0) {
      (extra as Record<string, unknown>).suppressed_prior_window = gate.suppressedPriorWindow;
    }
    return Sentry.captureException(error, {
      tags: context?.tags,
      extra,
    });
  } catch {
    // swallow
    return undefined;
  }
}

/** Capture a non-error message (e.g. unusual but non-fatal state). */
export function captureMessage(
  message: string,
  level: 'info' | 'warning' | 'error' = 'info',
  context?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
): void {
  if (!_initialized) return;
  // Only the 'warning' bucket is rate-limited — info is rare and intentional,
  // and error is rare enough that the caller should usually have used
  // `captureException` instead. This matches the plan's channel caps.
  if (level === 'warning') {
    const gate = shouldEmit('capture_message_warning', message);
    if (!gate.emit) return;
    try {
      const extra = { ...(context?.extra ?? {}) };
      if (gate.suppressedPriorWindow > 0) {
        (extra as Record<string, unknown>).suppressed_prior_window = gate.suppressedPriorWindow;
      }
      Sentry.captureMessage(message, { level, fingerprint: [message], tags: context?.tags, extra });
    } catch {
      // swallow
    }
    return;
  }
  try {
    Sentry.captureMessage(message, {
      level,
      fingerprint: [message],
      tags: context?.tags,
      extra: context?.extra,
    });
  } catch {
    // swallow
  }
}

type PhaseTagValue = string | number | boolean | null | undefined;

function phaseTagString(value: PhaseTagValue): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value).slice(0, 64);
}

function nowMs(): number {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
  } catch {
    // Fall back below.
  }
  return Date.now();
}

function bucketDuration(durationMs: number): string {
  if (durationMs >= 5000) return '5000ms_plus';
  if (durationMs >= 2000) return '2000ms_plus';
  if (durationMs >= 1000) return '1000ms_plus';
  if (durationMs >= 500) return '500ms_plus';
  if (durationMs >= 250) return '250ms_plus';
  return 'under_250ms';
}

/**
 * Measure an app-specific phase without adding required startup work.
 * Fixed phase names + low-cardinality tags only; callers must not pass PHI.
 */
export interface MeasurePhaseOptions {
  /**
   * Undefined preserves the existing 5-second warning. A positive number uses
   * a phase-specific threshold. Null keeps the breadcrumb but disables the
   * generic slow-phase warning.
   */
  warningThresholdMs?: number | null;
}

export function measurePhase<T>(
  name: string,
  tags: Record<string, PhaseTagValue> | undefined,
  fn: () => T,
  options?: MeasurePhaseOptions,
): T;
export function measurePhase<T>(
  name: string,
  tags: Record<string, PhaseTagValue> | undefined,
  fn: () => Promise<T>,
  options?: MeasurePhaseOptions,
): Promise<T>;
export function measurePhase<T>(
  name: string,
  tags: Record<string, PhaseTagValue> | undefined,
  fn: () => T | Promise<T>,
  options?: MeasurePhaseOptions,
): T | Promise<T> {
  const startedAt = nowMs();
  const configuredThreshold = options?.warningThresholdMs;
  const warningThresholdMs =
    configuredThreshold === null
      ? null
      : typeof configuredThreshold === 'number' && configuredThreshold > 0
        ? configuredThreshold
        : 5000;
  // performance.now() keeps counting while Android suspends the app, so a
  // phase awaited across a suspension reports minutes of wall time (observed:
  // a 614s registerDevice). Track whether the app left 'active' during the
  // measured window and suppress the slow-phase warning — the breadcrumb
  // keeps the raw duration so genuine latency stays observable.
  let leftActiveState = false;
  let appStateSubscription: { remove: () => void } | null = null;
  try {
    if (AppState.currentState != null && AppState.currentState !== 'active') {
      leftActiveState = true;
    }
    appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') leftActiveState = true;
    });
  } catch {
    // Guard is best-effort; measurement must never fail because of it.
  }
  const finish = (outcome: 'success' | 'error') => {
    try {
      appStateSubscription?.remove();
    } catch {
      // swallow
    }
    appStateSubscription = null;
    const durationMs = Math.max(0, Math.round(nowMs() - startedAt));
    const sanitizedTags: Record<string, string> = {
      phase: name,
      duration_bucket: bucketDuration(durationMs),
      outcome,
    };
    for (const [key, value] of Object.entries(tags ?? {})) {
      const safe = phaseTagString(value);
      if (safe !== undefined) sanitizedTags[key] = safe;
    }

    breadcrumb('performance', 'phase_complete', {
      phase: name,
      duration_ms: durationMs,
      duration_bucket: sanitizedTags.duration_bucket,
      outcome,
      skipped: sanitizedTags.skipped,
      count: sanitizedTags.count,
      ...(leftActiveState ? { app_suspended: 'true' } : {}),
    });

    if (warningThresholdMs !== null && durationMs >= warningThresholdMs && !leftActiveState) {
      captureMessage(`slow_phase_${name}`, 'warning', {
        tags: sanitizedTags,
        extra: { duration_ms: durationMs, warning_threshold_ms: warningThresholdMs },
      });
    }
  };

  try {
    const result = fn();
    if (result && typeof (result as Promise<T>).then === 'function') {
      return (result as Promise<T>).then(
        (value) => {
          finish('success');
          return value;
        },
        (error) => {
          finish('error');
          throw error;
        }
      );
    }
    finish('success');
    return result;
  } catch (error) {
    finish('error');
    throw error;
  }
}
