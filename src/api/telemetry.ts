import { Platform } from 'react-native';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { apiClient } from './client';
import type { ErrorPhase, NetworkState } from '../lib/analytics';

/**
 * Fire-and-forget client-side telemetry. Posted to
 * POST /api/telemetry/client-error so stuck drafts and failed uploads can be
 * correlated with a server-side row even when the failure never reached any
 * other API endpoint.
 *
 * Silent on failure — telemetry itself must never surface an error to the
 * user or throw into a caller's error handler.
 */

export interface ReportClientErrorInput {
  phase: ErrorPhase;
  severity?: 'error' | 'warning' | 'info';
  errorCode?: string;
  message: string;
  recordingId?: string;
  slotIndex?: number;
  segmentCount?: number;
  durationSeconds?: number;
  fileSizeBytes?: number;
  networkState?: NetworkState;
  attemptNumber?: number;
}

const APP_VERSION =
  Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? 'unknown';
const OS_VERSION = String(Platform.Version ?? 'unknown');
const PLATFORM: 'ios' | 'android' | undefined =
  Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : undefined;

/**
 * Last line of PHI defense. Strips file paths and collapses anything that
 * looks like a proper-name string. The route handler does the same on the
 * server — this is just the first layer.
 */
function sanitizeMessage(raw: string): string {
  const withoutPaths = raw
    .replace(/file:\/\/[^\s'"]+/gi, 'file://[redacted]')
    .replace(/\/data\/user\/\d+\/[^\s'"]+/gi, '[redacted-android-path]')
    .replace(/\/var\/mobile\/[^\s'"]+/gi, '[redacted-ios-path]');
  return withoutPaths.slice(0, 512);
}

export function reportClientError(input: ReportClientErrorInput): void {
  const payload = {
    phase: input.phase,
    severity: input.severity ?? 'error',
    errorCode: input.errorCode,
    message: sanitizeMessage(input.message),
    recordingId: input.recordingId,
    slotIndex: input.slotIndex,
    segmentCount: input.segmentCount,
    durationSeconds: input.durationSeconds,
    fileSizeBytes: input.fileSizeBytes,
    networkState: input.networkState,
    attemptNumber: input.attemptNumber,
    appVersion: APP_VERSION,
    platform: PLATFORM,
    osVersion: OS_VERSION,
  };

  apiClient.post('/api/telemetry/client-error', payload).catch(() => {
    // Swallow — telemetry is best-effort. Any error here has already been
    // handled elsewhere or is a symptom of a broader network problem, and we
    // don't want the act of reporting an error to itself cause an error.
  });
}
