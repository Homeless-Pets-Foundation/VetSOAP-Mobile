import * as Sentry from '@sentry/react-native';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { SENTRY_DSN } from '../config';

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
      // Sample a slice of transactions for performance monitoring. Errors are
      // always captured regardless of this rate.
      tracesSampleRate: 0.2,
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
  | 'network';

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

/** Capture a caught exception. */
export function captureException(
  error: unknown,
  context?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
): void {
  if (!_initialized) return;
  try {
    Sentry.captureException(error, {
      tags: context?.tags,
      extra: context?.extra,
    });
  } catch {
    // swallow
  }
}

/** Capture a non-error message (e.g. unusual but non-fatal state). */
export function captureMessage(
  message: string,
  level: 'info' | 'warning' | 'error' = 'info',
  context?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
): void {
  if (!_initialized) return;
  try {
    Sentry.captureMessage(message, {
      level,
      tags: context?.tags,
      extra: context?.extra,
    });
  } catch {
    // swallow
  }
}
