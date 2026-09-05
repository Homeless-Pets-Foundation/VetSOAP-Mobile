import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Alert,
  ActivityIndicator,
  AccessibilityInfo,
  Linking,
  Platform,
  Pressable,
  useWindowDimensions,
  FlatList,
  AppState,
  InteractionManager,
} from 'react-native';
import { Text } from '../../../src/components/ui/Text';
import type { AppStateStatus } from 'react-native';
import { useRouter, useNavigation, useLocalSearchParams } from 'expo-router';
import { usePreventRemove } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { Mic } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { safeDeleteFile, safeDeleteDirectory, fileExists, writeFilePrefix, ensureDirectory } from '../../../src/lib/fileOps';
import { getInfoAsync } from 'expo-file-system/legacy';
import { Paths } from 'expo-file-system';
import { maybeSplitForUpload, cleanupSplitTempDirs } from '../../../src/lib/oversizedSplit';
import type { checkAudioSilenceForUpload as CheckAudioSilenceForUpload } from '../../../src/lib/ffmpeg';
import {
  DISCARD_SESSION_COPY,
  MULTI_PATIENT_RECORD_FIRST_COPY,
  OVERSIZED_CONFIRM_COPY,
  RECORD_BANNERS,
  RECORDER_TRANSITION_COPY,
  REPLACE_SESSION_COPY,
  SILENT_CHECK_COPY,
  STASH_COPY,
  TEMPLATE_DEFAULT_COPY,
  UPLOAD_OVERLAY_COPY,
  UPLOAD_RECOVERY_COPY,
  METADATA_DIVERGENCE_COPY,
} from '../../../src/constants/strings';
import { Toast } from '../../../src/components/Toast';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { draftStorage } from '../../../src/lib/draftStorage';
import { rememberOrphanDraftId } from '../../../src/lib/orphanDraftRetry';
import { stashStorage, MAX_STASHES } from '../../../src/lib/stashStorage';
import { recoveryIntent, type RecoveryIntentReason } from '../../../src/lib/recoveryIntent';
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
} from 'expo-audio';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as audioFocus from '../../../modules/captivet-audio-focus';
import * as durableRecorder from '../../../modules/captivet-durable-recorder';
import { isDurableCaptureEnabled } from '../../../src/lib/durableFlag';
import { checkPreRecordFreeSpace, getFreeDiskBytes } from '../../../src/lib/freeSpace';
import { getRecordStartGate, ensureFloorHydrated } from '../../../src/lib/minVersion';
import { durableActiveStore } from '../../../src/lib/durableAudio/activeStore';
import { priorUncleanExitDetected } from '../../../src/lib/durableAudio/durableRecovery';
import { maybePromptBatteryOptimization } from '../../../src/lib/batteryOptimization';
import { durableTombstone } from '../../../src/lib/durableAudio/tombstone';
import { durableReconcileHold } from '../../../src/lib/durableAudio/reconcileHold';
import { withPromiseTimeout } from '../../../src/lib/promiseTimeout';
import { isValidDurableId, RECOVERED_DURABLE_DIR_NAME } from '../../../src/lib/durableAudio/paths';
import { durableRecoveryStore } from '../../../src/lib/durableAudio/recoveryState';
import { validatePendingConfirm } from '../../../src/lib/pendingConfirm';
import { getSecureRandomHex } from '../../../src/lib/random';
import {
  createAudioChangeUploadIdempotencyKey,
  createRestartUploadIdempotencyKey,
  effectiveUploadIdempotencyKey,
  isAudioChangeUploadIdempotencyKey,
  normalizeUploadIntentId,
} from '../../../src/lib/uploadIntent';
import { useAudioRecorder } from '../../../src/hooks/useAudioRecorder';
import { useConnectivity } from '../../../src/hooks/useConnectivity';
import { useAuthUser } from '../../../src/hooks/useAuth';
import { useMultiPatientSession } from '../../../src/hooks/useMultiPatientSession';
import { useStashedSessions } from '../../../src/hooks/useStashedSessions';
import { useResponsive } from '../../../src/hooks/useResponsive';
import { useThemeColors } from '../../../src/hooks/useThemeColors';
import { useTemplates } from '../../../src/hooks/useTemplates';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  recordingsApi,
  getUploadPhase,
  getUploadDiagnostic,
  getUploadRecoverableHint,
  isTransientUploadError,
  UploadIntentConflictError,
  type RecordingDeleteReason,
} from '../../../src/api/recordings';
import { networkStateFromNetInfo } from '../../../src/lib/networkState';
import { METADATA_MISMATCH_ERROR_CODE } from '../../../src/api/metadataMismatch';
import {
  RecordingMetadataConflictError,
  type MetadataDivergenceReport,
} from '../../../src/api/metadataIdentity';
import {
  getDraftPresenceSnapshot,
  linkedServerDraftIds,
} from '../../../src/api/draftPresence';
import { ApiError } from '../../../src/api/client';
import { patchDraftMetadataWithRetry } from '../../../src/lib/retryableCleanup';
import {
  trackEvent,
  type NetworkState,
  type AutoStashReason,
  type SubmitDiagnosticsProps,
} from '../../../src/lib/analytics';
import { breadcrumb, captureException, captureMessage, completePhaseFrom, measurePhase, nowMs } from '../../../src/lib/monitoring';
import { reportClientError } from '../../../src/api/telemetry';
import { DRAFT_DEBOUNCE_MS } from '../../../src/config';
import { audioEditorBridge } from '../../../src/lib/audioEditorBridge';
import { friendlyErrorMessage } from '../../../src/lib/errorCopy';
import { recordingActivity } from '../../../src/lib/recordingActivity';
import { recordSubmitAttempt } from '../../../src/lib/submitTiming';
import { setSessionActivity } from '../../../src/lib/sessionActivity';
import { templatePreference } from '../../../src/lib/templatePreference';
import { invalidateRecordingCaches } from '../../../src/lib/recordingQueryCache';
import {
  probePendingDurableAvailability,
  probePendingStandardAvailability,
  readDurableUploadMetadata,
  readUploadMetadataBatch,
} from '../../../src/lib/uploadPreflight';
import {
  isNativePreflightTimeout,
} from '../../../src/lib/nativePreflight';
import { createDurableUploadSnapshotUri } from '../../../src/lib/durableUploadSnapshot';
import { acquireKeepAwakeLease } from '../../../src/lib/keepAwakeLease';
import { presentNativePreflightTimeout } from '../../../src/lib/nativePreflightReporting';
import {
  canRecordAppointments,
  RECORD_APPOINTMENT_PERMISSION_MESSAGE,
  RECORD_APPOINTMENT_PERMISSION_TITLE,
} from '../../../src/lib/recordingPermissions';
import { PatientTabStrip } from '../../../src/components/PatientTabStrip';
import { PatientSlotCard } from '../../../src/components/PatientSlotCard';
import { SubmitPanel } from '../../../src/components/SubmitPanel';
import { StashedSessionCard } from '../../../src/components/StashedSessionCard';
import { UploadOverlay, countBatchCompleted } from '../../../src/components/UploadOverlay';
import { ScreenContainer } from '../../../src/components/ui/ScreenContainer';
import { Button } from '../../../src/components/ui/Button';
import { slotHasRecoverableAudio } from '../../../src/types/multiPatient';
import type { AudioSegment, PatientSlot } from '../../../src/types/multiPatient';
import type { CreateRecording } from '../../../src/types';
import { isPimsPatientIdExplicitlyCleared } from '../../../src/lib/pimsPatientIdIntent';

function uploadKeyForSlot(slot: PatientSlot): string {
  return effectiveUploadIdempotencyKey({
    uploadKeyOverride: slot.uploadKeyOverride,
    supersededUploadKey: slot.supersededUploadKey,
    durableRecordingId: slot.durable?.recordingId,
    uploadIntentId: slot.uploadIntentId,
    slotId: slot.id,
  });
}

const UPLOAD_RESTART_LOCAL_TIMEOUT_MS = 15_000;
/**
 * The post-confirm conversion runs INSIDE markSubmitIntent, before the restart
 * transaction's own watchdog exists. SecureStore and the Keystore hang rather
 * than reject on Direct Boot, low storage, or a corrupted keystore (rule 24),
 * and a hang there would freeze the Record UI until the app restarts. Bounded
 * separately, and shorter than the restart's own window since this is only a
 * file copy plus two small writes.
 */
const POST_CONFIRM_CONVERSION_TIMEOUT_MS = 12_000;
/**
 * Watchdog for the release transaction. It has no natural timeout of its own —
 * it is a chain of SecureStore, Keystore and native-purge calls, every one of
 * which can hang instead of rejecting (rule 24) — and it holds the slot's
 * mutation lock the whole time.
 */
const RECONCILE_TRANSACTION_TIMEOUT_MS = 15_000;

/**
 * "Truly unsaved" = work that would actually be lost if the session were
 * discarded: in-memory audio with no committed draft, or a live/paused
 * recorder. Slots with a `draftSlotId` are durable on disk + server (they
 * survive as "Not Submitted" cards on Home), so discard/replace flows must
 * neither count them as at-risk nor delete them.
 */
function isTrulyUnsavedSlot(s: PatientSlot): boolean {
  return (
    (slotHasRecoverableAudio(s) && !s.draftSlotId && s.uploadStatus !== 'success') ||
    // A successful upload whose IDENTITY diverged is not finished work: the
    // local copy is deliberately retained because the server row may describe a
    // different visit, and only the vet can decide. Every guard keyed on
    // "not success" would otherwise skip it — the background persist would not
    // save it and the nav guard would not protect it — so process death or a
    // cache sweep could take the only copy the vet still controls before they
    // choose. It stops counting as unsaved the moment a reconciliation action
    // resolves the divergence.
    (slotHasRecoverableAudio(s) &&
      s.uploadStatus === 'success' &&
      s.metadataDivergence?.tier === 'identity') ||
    s.audioState === 'recording' ||
    s.audioState === 'paused'
  );
}

/**
 * Draft ids for every slot committed as a draft — the preserve list for
 * discardCurrentSession. `excludeSlotIds` drops slots whose draftSlotId does
 * NOT identify a surviving local draft (resumed-from-stash slots until a
 * fresh autoSaveDraft commits): preserving those made discard skip
 * deleteSlotDraft, stranding the server draft as a "Not Submitted" row with
 * no audio after the stash release deleted the only copy (Codex P2, PR #143).
 */
function collectPreserveDraftSlotIds(
  slots: PatientSlot[],
  excludeSlotIds?: ReadonlySet<string>
): string[] {
  const ids: string[] = [];
  for (const s of slots) {
    if (s.draftSlotId && !excludeSlotIds?.has(s.id)) ids.push(s.draftSlotId);
  }
  return ids;
}

/**
 * Announce a transition for screen readers on iOS only. The on-card status
 * badge and the interruption banner already carry `accessibilityLiveRegion`
 * (Android-only), so an unconditional announce here double-speaks every
 * transition under TalkBack — mirror the iOS gating Toast/CopiedToast use
 * (Codex P2, PR #143).
 */
function announceForIOS(message: string): void {
  if (Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(message);
}

function PermissionGate({ onGranted }: { onGranted: () => void }) {
  const { scale } = useResponsive();
  const colors = useThemeColors();
  const [requesting, setRequesting] = useState(false);

  const handleRequest = () => {
    setRequesting(true);
    requestRecordingPermissionsAsync()
      .then(({ granted, canAskAgain }) => {
        if (granted) {
          onGranted();
          return;
        }
        trackEvent({ name: 'mic_permission_denied', props: { can_ask_again: canAskAgain } });
        if (!canAskAgain) {
          Alert.alert(
            'Permission Required',
            'Microphone access was denied. Please enable it in your device Settings to record appointments.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Open Settings',
                onPress: () => {
                  Linking.openSettings().catch(() => {});
                },
              },
            ]
          );
        }
      })
      .catch(() => {})
      .finally(() => {
        setRequesting(false);
      });
  };

  return (
    <ScreenContainer>
      <View className="flex-1 justify-center items-center px-6">
        <View
          className="bg-brand-50 dark:bg-surface-sunken rounded-full justify-center items-center mb-6"
          style={{ width: scale(96), height: scale(96) }}
        >
          <Mic color={colors.brand500} size={scale(40)} />
        </View>
        <Text className="text-display font-bold text-content-primary text-center mb-3">
          Microphone Access
        </Text>
        <Text className="text-body text-content-tertiary text-center mb-8">
          Captivet needs microphone permission to record veterinary appointments and generate SOAP notes.
        </Text>
        <Button
          variant="primary"
          size="lg"
          onPress={handleRequest}
          loading={requesting}
          accessibilityLabel="Continue to microphone permission prompt"
        >
          Continue
        </Button>
      </View>
    </ScreenContainer>
  );
}

function showRecordPermissionAlert(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
  Alert.alert(RECORD_APPOINTMENT_PERMISSION_TITLE, RECORD_APPOINTMENT_PERMISSION_MESSAGE);
}

function showUploadInProgressAlert(): void {
  Alert.alert(
    'Upload in Progress',
    'Please wait for this recording upload to finish before changing its audio.',
  );
}

function isExpectedSubmitApiFailure(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return (
    error.code === 'ROLE_FORBIDDEN' ||
    error.code === 'CREDENTIALS_REQUIRED' ||
    error.status === 404
  );
}

// A submit failure is "recoverable" when it is not a genuine mobile-side bug:
// the user (or a retry) can succeed without a code change. These are reported
// as telemetry warnings and must NOT fire captureException, which would page a
// recovered or server-side fault as a hard error. Covers:
//   - isExpectedSubmitApiFailure: ROLE_FORBIDDEN / CREDENTIALS_REQUIRED / 404
//   - server faults: any HTTP 5xx (server bug, not a mobile bug — still tracked
//     via reportClientError so the server team keeps visibility)
//   - transient network death: matched by isTransientUploadError (also drives
//     auto-stash for retry below)
//   - silent_check: user declined the explicit Upload Anyway confirmation
//   - aborts: request timeout / cancel (AbortError), which the transient regex
//     does not match (Sentry REACT-NATIVE-W)
function isRecoverableSubmitFailure(error: unknown): boolean {
  if (isNativePreflightTimeout(error)) return true;
  if (isExpectedSubmitApiFailure(error)) return true;
  if (isTransientUploadError(error)) return true;
  if (getUploadPhase(error) === 'silent_check') return true;
  // patch_draft is recoverable ONLY when the throw site says so. The
  // post-confirm metadata assertion (recordings.ts postConfirm / confirmUpload)
  // fires AFTER a successful confirm-upload: the bytes are in R2 and the server
  // has already enqueued processing, so the user's submit dead-ends and no
  // retry converges. Idempotent replay origins (409 probe / already_uploaded /
  // recovery) keep PR #92's warning classification, as does any patch_draft
  // error carrying no hint (the legacy draft-metadata PATCH).
  if (getUploadPhase(error) === 'patch_draft') return getUploadRecoverableHint(error) ?? true;
  const e = error as { status?: number; name?: string; message?: string } | null;
  if (typeof e?.status === 'number' && e.status >= 500) return true;
  if (e?.name === 'AbortError' || /\bAborted\b/i.test(e?.message ?? '')) return true;
  return false;
}

function RecordingRoleGate() {
  const router = useRouter();
  const { scale } = useResponsive();
  const colors = useThemeColors();

  return (
    <ScreenContainer>
      <View className="flex-1 justify-center items-center px-6">
        <View
          className="bg-surface-sunken rounded-full justify-center items-center mb-6"
          style={{ width: scale(96), height: scale(96) }}
        >
          <Mic color={colors.contentTertiary} size={scale(40)} />
        </View>
        <Text className="text-display font-bold text-content-primary text-center mb-3">
          {RECORD_APPOINTMENT_PERMISSION_TITLE}
        </Text>
        <Text className="text-body text-content-tertiary text-center mb-8">
          {RECORD_APPOINTMENT_PERMISSION_MESSAGE}
        </Text>
        <Button
          variant="secondary"
          size="lg"
          onPress={() => router.replace('/')}
          accessibilityLabel="Return to home"
        >
          Back to Home
        </Button>
      </View>
    </ScreenContainer>
  );
}

function isSlotActivelyRecording(slot: PatientSlot): boolean {
  return slot.audioState === 'recording' || slot.audioState === 'paused';
}

/**
 * Match URIs owned by `draftStorage` so segment-URI cleanup paths skip them.
 * Post-PROMOTE_SEGMENTS_TO_DRAFT (Sentry REACT-NATIVE-8 fix), a slot's
 * `segments[].uri` points at durable copies under
 * `documentDirectory/drafts/{userId}/{slotId}/seg_N.m4a`. That directory is
 * the authority of `draftStorage.deleteDraft`; double-deleting from
 * `discardSlot` races and can leave a half-cleaned draft visible if the slot
 * is also referenced from a pinned stash.
 */
function isDraftOwnedUri(uri: string): boolean {
  return uri.includes('/drafts/');
}

function isNetworkRequestFailed(error: unknown): boolean {
  return error instanceof TypeError && /network request failed/i.test(error.message);
}

// -35 dBFS: covers soft speech close to the mic without missing dead-mic recordings
// (mic noise floor sits around -60 to -70 dBFS). Earlier value (-20 dBFS) tripped
// false positives on Pixel devices where expo-audio reports a depressed peak even
// though file playback is clearly audible.
const SILENT_METERING_THRESHOLD_DB = -35;
const SHORT_AUDIO_FFMPEG_SILENCE_SECONDS = 15;
const MISSING_METERING_FFMPEG_MAX_SECONDS = 180;
const RECORDING_KEEP_AWAKE_TAG = 'captivet-recording';

type SilenceCheckReason =
  | 'metering_all_below_threshold'
  | 'ffmpeg_all_segments_silent'
  | 'missing_metering_long_recording'
  | 'ffmpeg_timeout'
  | 'ffmpeg_error';

function countBlankRecordFirstFields(formData: CreateRecording): number {
  return [
    formData.patientName,
    formData.clientName,
    formData.species,
    formData.appointmentType,
  ].filter((value) => !String(value ?? '').trim()).length;
}

async function checkSilentAudio(slot: PatientSlot): Promise<{
  silent: boolean;
  inconclusive: boolean;
  reason: SilenceCheckReason | null;
}> {
  // Durable slot: no segments[] — build the guard from the manifest peakDb
  // (PCM-domain dBFS, same reference as expo-audio's peakMetering). Without this
  // the guard is a no-op for every durable upload (empty segments -> fail open).
  if (slot.durable) {
    return slot.durable.peakDb <= SILENT_METERING_THRESHOLD_DB
      ? { silent: true, inconclusive: false, reason: 'metering_all_below_threshold' }
      : { silent: false, inconclusive: false, reason: null };
  }
  if (slot.segments.length === 0) return { silent: false, inconclusive: false, reason: null };

  const durationSeconds = slot.segments.reduce((sum, seg) => sum + (seg.duration ?? 0), 0);
  const hasCompleteMetering = slot.segments.every((seg) => typeof seg.peakMetering === 'number');
  if (
    hasCompleteMetering &&
    slot.segments.every((seg) => (seg.peakMetering ?? 0) <= SILENT_METERING_THRESHOLD_DB)
  ) {
    return { silent: true, inconclusive: false, reason: 'metering_all_below_threshold' };
  }

  const shouldRunFfmpeg =
    durationSeconds <= SHORT_AUDIO_FFMPEG_SILENCE_SECONDS ||
    (!hasCompleteMetering && durationSeconds <= MISSING_METERING_FFMPEG_MAX_SECONDS);

  if (!shouldRunFfmpeg) {
    return hasCompleteMetering
      ? { silent: false, inconclusive: false, reason: null }
      : { silent: false, inconclusive: true, reason: 'missing_metering_long_recording' };
  }

  try {
    let inconclusiveReason: 'ffmpeg_timeout' | 'ffmpeg_error' | null = null;
    // Read every silence-analysis input under one metadata-only budget before
    // FFmpeg starts. FFmpeg execution time must not consume the next stat's
    // deadline, while 20 sequential native stats still remain capped at 10s.
    const silenceMetadata = await readUploadMetadataBatch(
      slot.segments.map((segment) => segment.uri),
      'standard',
      'silence_metadata',
      getInfoAsync,
    );
    for (let index = 0; index < slot.segments.length; index++) {
      const segment = slot.segments[index];
      // Lazy (rule 19). src/lib/ffmpeg imports ffmpeg-kit-react-native, whose
      // module load links the FFmpeg native libraries into the process. As a
      // static import that happened on every Record-tab mount — on the low-end
      // Galaxy Tab A7 Lite fleet that is heap pressure paid for a check that
      // only runs at submit time. The sibling static import via oversizedSplit
      // is lazied for the same reason; make BOTH lazy or neither helps.
      const checkAudioSilenceForUpload: typeof CheckAudioSilenceForUpload =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../../../src/lib/ffmpeg').checkAudioSilenceForUpload;
      const result = await checkAudioSilenceForUpload(
        segment.uri,
        {},
        { metadata: silenceMetadata[index] },
      );
      if (result.status === 'not_silent') {
        return { silent: false, inconclusive: false, reason: null };
      }
      if (result.status === 'inconclusive') {
        inconclusiveReason ??= result.reason;
      }
    }

    return inconclusiveReason
      ? { silent: false, inconclusive: true, reason: inconclusiveReason }
      : { silent: true, inconclusive: false, reason: 'ffmpeg_all_segments_silent' };
  } catch (error) {
    if (isNativePreflightTimeout(error)) throw error;
    return { silent: false, inconclusive: true, reason: 'ffmpeg_error' };
  }
}

async function sumSegmentSizes(segments: AudioSegment[]): Promise<number> {
  const metadata = await readUploadMetadataBatch(
    segments.map((segment) => segment.uri),
    'standard',
    'split_output_metadata',
    getInfoAsync,
  );
  let totalBytes = 0;
  for (const info of metadata) {
    if (!info.exists) {
      throw new Error('Failed to read the prepared audio file. Please try again.');
    }
    const size = info.size ?? 0;
    if (!size) {
      throw new Error('The prepared audio file is empty. Please try again.');
    }
    totalBytes += size;
  }
  return totalBytes;
}

// ─── Durable capture helpers ───────────────────────────────────────────────
const DURABLE_OP_WATCHDOG_MS = 12000;

function newDurableRecordingId(): string {
  return `dr-${getSecureRandomHex(16)}`;
}

/**
 * Rule 24 hard watchdog around native mic/FGS/AVAudioEngine ops that gate a
 * render state — on a silent native hang (locked storage, permission edge) it
 * rejects so callers flip out of the gating state into a recoverable error.
 */
/**
 * Bound on the teardown finalize. Rule 24: the durable stop is a native bridge
 * call that can hang, and this runs in an unmount cleanup that cannot await. On
 * expiry the capture pointers are deliberately KEPT — see the teardown effect.
 */
const DURABLE_TEARDOWN_STOP_TIMEOUT_MS = 5_000;

async function withDurableOpWatchdog<T>(
  p: Promise<T>,
  op: 'start' | 'pause' | 'resume' | 'stop',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      captureMessage('durable_recorder_op_watchdog', 'warning', { tags: { op } });
      trackEvent({ name: 'durable_recorder_op_watchdog', props: { op } });
      reject(new Error(`durable ${op} timed out`));
    }, DURABLE_OP_WATCHDOG_MS);
  });
  try {
    return await Promise.race([p, watchdog]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The durable "active pointer" is a death-surviving breadcrumb that should be
// written (best-effort) BEFORE native start, but it goes through SecureStore and
// can hang forever on a locked Keystore (Direct Boot / low storage). A trailing
// `.catch()` only handles rejection, not a hang — awaiting it unbounded would
// strand `startInFlightRef` + the recorder binding before withDurableOpWatchdog()
// or the start handler's finally ever runs, locking recording until app restart.
// Bound the write with a short timeout that RESOLVES (never rejects) so start
// always proceeds. Tradeoff: on timeout the pointer is skipped, losing only the
// "prior process died mid-capture" launch breadcrumb — crash recovery still
// reconstructs the recording from the native manifest.
const DURABLE_ACTIVE_WRITE_TIMEOUT_MS = 3000;

/**
 * Bound for the expo capture pointer, which is awaited BEFORE the mic opens.
 *
 * Deliberately far tighter than DURABLE_ACTIVE_WRITE_TIMEOUT_MS (3000): that
 * one guards a write which overlaps native start and so can afford to wait,
 * whereas this one sits in front of the microphone and any time spent here is
 * tap latency — the exact regression the record-perf work removed.
 *
 * 400 ms is chosen against measurements, not taste. Post-perf-work a setActive
 * on a short list is ~4 Keystore round trips (the 16 blind stale-chunk deletes
 * are gone, threaded through prevChunkCount), while Sentry measured
 * recorder_audio_prepare at 1763 ms on the SM-T220 fleet. So the write
 * essentially always wins the race anyway; this bound only caps the pathological
 * degraded-Keystore case, where we open the mic regardless rather than make the
 * vet wait. Capturing audio matters more than being able to attribute its loss.
 */
const EXPO_PRESTART_POINTER_TIMEOUT_MS = 400;

/**
 * Same shape as raceDurableActiveWrite but on the pre-start budget.
 *
 * Separate function on purpose: the durable pointer write must NEVER be awaited
 * before native start (fenced by tests/record-start-feedback.test.mjs and
 * tests/durable-recorder-plan.test.mjs), and reusing that helper's name here
 * would blur an invariant those fences exist to protect.
 */
function racePreStartPointerWrite(p: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, EXPO_PRESTART_POINTER_TIMEOUT_MS);
  });
  return Promise.race([p.catch(() => {}), bound]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function raceDurableActiveWrite(p: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, DURABLE_ACTIVE_WRITE_TIMEOUT_MS);
  });
  return Promise.race([p.catch(() => {}), bound]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Sentinel error thrown when the user taps Cancel on the oversize confirm dialog. */
class UploadCancelledByUser extends Error {
  constructor() {
    super('Upload cancelled by user');
    this.name = 'UploadCancelledByUser';
  }
}

function slotHasRequiredSubmitFields(slot: PatientSlot): boolean {
  return (
    slot.formData.patientName.trim().length > 0 &&
    (slot.formData.clientName?.trim().length ?? 0) > 0 &&
    (slot.formData.species?.trim().length ?? 0) > 0 &&
    !!slot.formData.appointmentType
  );
}

function slotSubmitDiagnostics(
  slot: PatientSlot,
  slotCount: number,
  opts?: {
    confirmUsedAtomicMetadataUpdate?: boolean;
    staleDraftPromotionBlocked?: boolean;
  }
): SubmitDiagnosticsProps {
  return {
    slot_count: slotCount,
    has_existing_server_draft: !!slot.serverDraftId,
    has_pending_confirm: !!slot.pendingConfirm,
    draft_metadata_dirty: !!slot.draftMetadataDirty,
    confirm_used_atomic_metadata_update: !!opts?.confirmUsedAtomicMetadataUpdate,
    stale_draft_promotion_blocked: !!opts?.staleDraftPromotionBlocked,
    species_present: (slot.formData.species?.trim().length ?? 0) > 0,
    breed_present: (slot.formData.breed?.trim().length ?? 0) > 0,
    appointment_type_present: !!slot.formData.appointmentType,
    client_last_name_present: (slot.formData.clientName?.trim().length ?? 0) > 0,
  };
}

/**
 * Tail of the serialized startup-sweep chain.
 *
 * The mount sweeps each walk every local draft, and one draft costs
 * `1 + chunkCount` AndroidKeyStore round-trips. Run concurrently on the
 * low-end Galaxy Tab A7 Lite fleet they starved the JS thread — Sentry showed
 * slow_phase_fetchUser at 14 456 ms against a 10 000 ms threshold and
 * init_watchdog_fired with 734 MB still free, i.e. contention, not memory.
 *
 * Serializing also FIXES an ordering bug: the 30-day eviction used to read its
 * draft list concurrently with the orphan sweep, so it classified rows that
 * cleanup was in the middle of deleting. Chained, eviction sees post-cleanup
 * state.
 *
 * Deliberately module-scoped, not a ref: the chain must outlive a remount of
 * the Record tab, and a rejected link must not poison the tail.
 */
let startupSweepTail: Promise<void> = Promise.resolve();

/**
 * Per-job ceiling for the serialized startup sweeps. Generous — these legitimately
 * walk every local draft over the Keystore on a slow tablet (Sentry has seen
 * local_draft_list past 5 s) — but finite, so one hung native read cannot
 * permanently strand the queue.
 */
const STARTUP_SWEEP_TIMEOUT_MS = 60_000;

function scheduleNonUrgentWork(
  label: string,
  // `isExpired()` goes true once this job has passed its deadline and the queue
  // has moved on. Serialized sweeps MUST fold it into their own scope predicate:
  // withPromiseTimeout only settles the wrapper, so without it a slow orphan
  // cleanup keeps running concurrently with the eviction pass that overtook it —
  // reintroducing the overlapping Keystore load and the mid-deletion
  // classification ordering that serializing them was added to prevent.
  work: (isExpired: () => boolean) => Promise<void>,
  fallbackMs = 2_500,
  warningThresholdMs: number | null = 10_000,
  // Queue behind the other serialized sweeps instead of racing them. Only for
  // the heavy mount-once sweeps — never for work that drives visible UI state,
  // which must not sit behind a multi-second eviction pass.
  serial = false
): () => void {
  let cancelled = false;
  let started = false;
  const run = () => {
    if (cancelled || started) return;
    started = true;
    let expired = false;
    const isExpired = (): boolean => expired;
    if (!serial) {
      measurePhase(label, undefined, () => work(isExpired), { warningThresholdMs }).catch(() => {});
      return;
    }
    startupSweepTail = startupSweepTail
      // Re-check after the wait: the effect may have been torn down (unmount,
      // user switch) while we were queued, and every sweep's own isScopeValid()
      // guard also re-runs inside work().
      .then(() =>
        cancelled
          ? undefined
          : // Rule 24: these sweeps are made of SecureStore reads, which hang
            // silently on a degraded Keystore. A never-settling job would leave
            // this module-scoped tail pending forever, stranding every later
            // orphan cleanup and eviction for the rest of the process — the
            // rejection handler below only recovers from a SETTLED rejection.
            // The deadline settles the queue so the next job still runs; the
            // hung work is left to finish or not on its own, and its own
            // isScopeValid() guard stops it acting on stale scope.
            withPromiseTimeout(
              measurePhase(label, undefined, () => work(isExpired), { warningThresholdMs }),
              STARTUP_SWEEP_TIMEOUT_MS,
              `startup_sweep_timeout:${label}`,
            ),
      )
      .then(
        () => {},
        () => {
          // Timed out (or failed). Mark it expired so the still-running work
          // stops at its next scope check instead of racing the job that is
          // about to start. A failed sweep must not break the chain either.
          expired = true;
        },
      );
  };
  const task = InteractionManager.runAfterInteractions(() => {
    run();
  });
  const fallback = setTimeout(run, fallbackMs);
  return () => {
    cancelled = true;
    clearTimeout(fallback);
    task.cancel?.();
  };
}

/** Promise-wrapped Alert.alert offering Upload Anyway when silence-check trips. */
function confirmSilentUpload(opts?: { durable?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      SILENT_CHECK_COPY.title,
      // Durable captures can't open Edit Recording, so the standard body's
      // "verify in Edit Recording" instruction would be impossible to follow.
      opts?.durable ? SILENT_CHECK_COPY.bodyDurable : SILENT_CHECK_COPY.body,
      [
        { text: SILENT_CHECK_COPY.cancel, style: 'cancel', onPress: () => resolve(false) },
        { text: SILENT_CHECK_COPY.upload, style: 'default', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });
}

/** Promise-wrapped Alert.alert with a yes/no choice. Resolves true on confirm, false on cancel. */
function confirmOversizedUpload(hours: number, mb: number, parts: number): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      OVERSIZED_CONFIRM_COPY.title,
      OVERSIZED_CONFIRM_COPY.body(hours, mb, parts),
      [
        { text: OVERSIZED_CONFIRM_COPY.cancel, style: 'cancel', onPress: () => resolve(false) },
        { text: OVERSIZED_CONFIRM_COPY.upload, style: 'default', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });
}

interface PersistableRecorderSnapshot {
  audioUri: string | null;
  duration: number;
  maxMetering?: number;
}

function RecordingSession() {
  const router = useRouter();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const user = useAuthUser();
  const authScopeKey = user ? `${user.organizationId}\u0000${user.id}` : null;
  const authScopeKeyRef = useRef<string | null>(null);
  const authScopeGenerationRef = useRef(0);
  const authScopeMountedRef = useRef(true);
  if (authScopeKeyRef.current !== authScopeKey) {
    authScopeKeyRef.current = authScopeKey;
    authScopeGenerationRef.current += 1;
  }
  useEffect(() => {
    authScopeMountedRef.current = true;
    return () => {
      authScopeMountedRef.current = false;
      authScopeGenerationRef.current += 1;
    };
  }, []);
  const recordFirstEnabled = user?.capabilities?.includes('record_first') ?? false;
  const recorder = useAudioRecorder();
  const colors = useThemeColors();
  const { width: screenWidth } = useWindowDimensions();
  const { templates, defaultTemplate, isLoading: templatesLoading } = useTemplates();
  const [preferredTemplateId, setPreferredTemplateId] = useState<string | null | undefined>(undefined);
  const [defaultTemplateSavingId, setDefaultTemplateSavingId] = useState<string | null>(null);
  const effectiveDefaultTemplate = useMemo(() => {
    if (preferredTemplateId === undefined) return null;
    if (preferredTemplateId) {
      return templates.find((template) => template.id === preferredTemplateId) ?? defaultTemplate;
    }
    return defaultTemplate;
  }, [defaultTemplate, preferredTemplateId, templates]);

  const {
    state: session,
    hasUnsavedRecordings,
    addSlot,
    removeSlot,
    setActiveIndex,
    updateForm,
    setAudioState,
    saveAudio,
    clearAudio,
    continueRecording,
    setDurableRecording,
    bindRecorder,
    unbindRecorder,
    setUploadStatus,
    resetSession,
    restoreSession,
    replaceAllSegments,
    dispatch,
  } = useMultiPatientSession(effectiveDefaultTemplate?.id);

  // Always-current mirror of `session`. Callbacks that need fresh state at
  // invocation time read from `sessionRef.current` and drop `session.*` from
  // their deps. This makes handler identity stable, which lets memoized
  // children (PatientSlotCard) keep them across renders without hiding state
  // updates behind stale closures. The assignment runs on every render before
  // any of our effects/handlers fire.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const multiPatientRecordFirstWarningShownRef = useRef(false);

  const {
    stashes,
    stashCount,
    isAtCapacity,
    isLoading: stashesLoading,
    stashSession,
    resumeSession: resumeStashedSession,
    markResumed,
    releaseResumedStash,
    deleteStash,
  } = useStashedSessions(user?.id ?? null);

  // Tracks the stash ID the current active session was restored from. Kept in
  // a ref so resolution paths (upload, discard, re-stash) can fully release the
  // pinned stash entry and audio directory. See Finding 1 in the audit.
  const resumedFromStashIdRef = useRef<string | null>(null);

  const releaseResumedStashIfAny = useCallback(() => {
    const stashId = resumedFromStashIdRef.current;
    if (!stashId) return;
    resumedFromStashIdRef.current = null;
    releaseResumedStash(stashId).catch(() => {});
  }, [releaseResumedStash]);

  /** Best-effort cleanup for an intent the user explicitly abandons. */
  const deleteOrphanServerRecording = useCallback((
    slot: PatientSlot,
    reason: RecordingDeleteReason = 'orphan_pending_confirm'
  ) => {
    const recordingId = slot.pendingConfirm?.recordingId;
    if (!recordingId) return;
    recordingsApi.delete(recordingId, { reason }).catch(() => {});
  }, []);

  /** Delete only the local auto-saved draft metadata/audio for a slot. */
  const deleteLocalSlotDraft = useCallback((slot: PatientSlot) => {
    Promise.all([
      draftStorage.deleteDraft(slot.id).catch(() => {}),
      recoveryIntent.clearForDraftSlot(slot.id).catch(() => {}),
    ]).then(() => {
      invalidateRecordingCaches(queryClient, 'draft_deleted');
    }).catch(() => {});
  }, [queryClient]);

  /**
   * Delete the auto-saved draft tied to a slot — both the local SecureStore
   * entry and the server Recording row (if one was created). Used when the
   * user discards a session: the recording is no longer useful and would
   * otherwise linger as a ghost "Not Submitted" row on Home plus PHI on disk.
   */
  const deleteSlotDraft = useCallback((
    slot: PatientSlot,
    reason: RecordingDeleteReason = 'discard_session'
  ) => {
    deleteLocalSlotDraft(slot);
    if (slot.serverDraftId && slot.uploadStatus !== 'success') {
      recordingsApi.delete(slot.serverDraftId, { reason }).catch(() => {});
    }
  }, [deleteLocalSlotDraft]);

  // Synchronous mirror for guards: while a Submit All batch runs, the whole
  // session is frozen (even with the overlay hidden via the escape hatch), so
  // no new slot/recording — and no metadata edit — can be created and then
  // silently discarded by the post-batch resetSession() (Codex P1, PR #143).
  // Declared here (before handleUpdateForm) to avoid a TDZ reference; its
  // value is refreshed each render right after the isSubmittingAll state below.
  const isSubmittingAllRef = useRef(false);
  // Controlled upload-intent restart snapshots audio and metadata together.
  // Keep this guard above every metadata-update entry point so delayed form or
  // lookup callbacks cannot mutate the slot after that snapshot was taken.
  const uploadRestartSlotIdsRef = useRef<Set<string>>(new Set());

  /** Metadata edits retain the stable upload intent and any complete R2 hint. */
  const handleUpdateForm = useCallback(
    (slotId: string, field: keyof CreateRecording, value: string | boolean | undefined) => {
      // Frozen during Submit All: the upload loop holds a pre-edit slot
      // snapshot (edits wouldn't reach the server) and the post-batch reset
      // would discard them anyway (Codex P1, PR #143).
      if (
        isSubmittingAllRef.current ||
        uploadRestartSlotIdsRef.current.has(slotId)
      ) {
        return;
      }
      updateForm(slotId, field, value);
    },
    [updateForm]
  );

  const [isSubmittingAll, setIsSubmittingAll] = useState(false);
  // Refresh the guard mirror declared above handleUpdateForm each render.
  isSubmittingAllRef.current = isSubmittingAll;
  const [submittingSlotId, setSubmittingSlotId] = useState<string | null>(null);
  // Slot ids in the current submit batch — UploadOverlay scopes its
  // progress math to these (WP6: cross-batch counting inflated progress).
  const [batchSlotIds, setBatchSlotIds] = useState<string[]>([]);
  const [uploadOverlayHidden, setUploadOverlayHidden] = useState(false);
  const [isStashing, setIsStashing] = useState(false);
  // Refs provide synchronous upload ownership, while this count makes those
  // mutations visible to render-time controls such as Save for Later.
  const [submitIntentCount, setSubmitIntentCount] = useState(0);
  const [uploadRestartCount, setUploadRestartCount] = useState(0);
  const [finishingDraftSlotId, setFinishingDraftSlotId] = useState<string | null>(null);
  // Slot whose Start tap has been acknowledged and whose start chain is in
  // flight. Set synchronously on the tap frame (before any await) and cleared
  // in startRecordingForSlot's finally, so the card's button reacts at once
  // instead of looking idle until the hook's own isStarting flips.
  const [startingSlotId, setStartingSlotId] = useState<string | null>(null);
  // Render-visible mirror of pendingStartSlotQueueRef (stop-then-start queue):
  // a slot waiting for the previous recording to stop shows the same spinner
  // as a slot whose start chain is running. Cleared the moment the queue pops
  // it — startRecordingForSlot then takes over via startingSlotId — so a
  // popped start that early-returns can never strand a spinner.
  const [queuedStartSlotIds, setQueuedStartSlotIds] = useState<string[]>([]);
  const [hasPendingDrafts, setHasPendingDrafts] = useState(false);
  // Set when an audio session interruption (incoming call, Siri, etc.) tore
  // down the recording mid-stream. The hook captures the partial segment and
  // transitions to `'interrupted'`; we save it and remember which slot to
  // resume in once AppState returns to 'active' (call ended).
  const [interruptionPendingResume, setInterruptionPendingResume] = useState<{ slotId: string } | null>(null);
  // The AppState handler reads this from a ref — its effect deps are pinned
  // to avoid re-subscribing AppState on every state mutation.
  const interruptionPendingResumeRef = useRef<{ slotId: string } | null>(null);
  // Durable interruptions finalize the recording (no auto-resume in v1); this
  // drives an explanatory, dismissible banner so the capture doesn't silently
  // flip from "Recording…" to "Recording Complete" mid-exam.
  const [durableInterruptionNotice, setDurableInterruptionNotice] = useState(false);
  // Transient toast shown when swiping away from a live recording auto-pauses
  // it — without this the only feedback is a haptic, and a vet can keep
  // talking while nothing records.
  const [pauseToast, setPauseToast] = useState<string | null>(null);
  const hidePauseToast = useCallback(() => setPauseToast(null), []);
  // isConnected-only subscription: `useNetInfo()` re-rendered this 7,000-line
  // screen (and every mounted slot card) on every connection-detail change.
  // uploadSlot's dep array is pinned and excludes the network state, so a
  // closure over it reports the transport as it was when the callback was
  // created — which for a multi-minute upload is not the transport it died on.
  // The hook mirrors the full state into this ref (same pattern as sessionRef
  // above) so the catch block can read the CURRENT value. A ref, not
  // `await NetInfo.fetch()`: the catch must neither throw nor hang. Declared
  // HERE (not returned by the hook) so exhaustive-deps keeps treating it as a
  // stable ref in the pinned callbacks below.
  const netInfoRef = useRef<NetInfoState | null>(null);
  const isConnected = useConnectivity(netInfoRef);
  // Derives a coarse connection descriptor for telemetry. Don't leak SSIDs or
  // carrier names — only the type bucket.
  const networkStateForTelemetry = (): NetworkState =>
    networkStateFromNetInfo(netInfoRef.current);
  // Per-slot retry counter — increments each time uploadSlot runs. Drives the
  // `attempt_number` field on submit events and client-error telemetry so we
  // can see recordings that fail multiple attempts vs one-shot failures.
  const uploadAttemptCountsRef = useRef<Map<string, number>>(new Map());
  const pagerRef = useRef<FlatList>(null);
  const isScrollingRef = useRef(false);
  const swipeChangeRef = useRef(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const backgroundPersistingRef = useRef(false);
  // Track pending slots for "stop A then start B (then C…)" flow. FIFO queue —
  // rapid tap of Start across multiple slots during a stop-in-progress used to
  // overwrite a single ref, dropping all but the latest tap. Queue preserves
  // each tap; effect pops the head when the recorder finishes stopping.
  const pendingStartSlotQueueRef = useRef<string[]>([]);
  const enqueuePendingStart = useCallback((slotId: string) => {
    const q = pendingStartSlotQueueRef.current;
    if (!q.includes(slotId)) q.push(slotId);
    setQueuedStartSlotIds((ids) => (ids.includes(slotId) ? ids : [...ids, slotId]));
  }, []);
  const removePendingStart = useCallback((slotId: string) => {
    const q = pendingStartSlotQueueRef.current;
    const idx = q.indexOf(slotId);
    if (idx !== -1) q.splice(idx, 1);
    setQueuedStartSlotIds((ids) => ids.filter((id) => id !== slotId));
  }, []);
  // Track pending stash for "stop recorder then stash" flow
  const pendingStashRef = useRef(false);
  // Track pending draft for "stop recorder then auto-save draft" flow
  const pendingDraftSlotIdRef = useRef<string | null>(null);
  // Slot ids whose CURRENT audio has not yet been persisted by autoSaveDraft
  // (save in flight, save failed, or save still pending in the deferred
  // effect). draftSlotId alone only proves an older snapshot was saved —
  // treating it as safe let a discard silently drop a freshly recorded
  // segment (Codex P1, PR #143). Cleared per-slot on save success and
  // wholesale on session reset/discard.
  const unsyncedDraftAudioRef = useRef<Set<string>>(new Set());
  // Slot ids restored from a stash whose retained draftSlotId does NOT map to
  // a surviving local draft (stashing deleted it — the stash owns the audio).
  // Distinct from unsyncedDraftAudioRef: an in-flight/failed autoSaveDraft
  // still has an OLDER durable snapshot worth preserving on discard, whereas
  // these slots have none — preserving their draftSlotId strands the server
  // draft row as an audio-less "Not Submitted" card (Codex P2, PR #143).
  // Cleared per-slot on autoSaveDraft success, wholesale on discard.
  const stashResumedSlotIdsRef = useRef<Set<string>>(new Set());
  const pendingDraftMinSegmentCountRef = useRef<number>(0);
  const pendingDraftRecoveryReasonRef = useRef<Map<string, RecoveryIntentReason>>(new Map());
  // Ref for startRecordingForSlot to avoid hoisting issues in the effect
  const startRecordingRef = useRef<(slotId: string) => void>(() => {});
  const rotateDurableAudioIdentityRef = useRef<
    (slot: PatientSlot) => Promise<string | null>
  >(async () => null);
  // Single-flight guard for startRecordingForSlot. Prevents a second concurrent
  // invocation (e.g. user-retap during a 250ms pending-start-queue setTimeout,
  // or any path where two start calls overlap) from racing the first: the
  // second's catch unbinds while the first's success writes audioState='recording',
  // leaving slot.audioState='recording' with recorderBoundToSlotId=null.
  const startInFlightRef = useRef(false);
  const autoSaveDraftRef = useRef<(slot: PatientSlot) => Promise<boolean>>(async () => false);
  // Guard: prevent the audio-capture effect from saving twice for the same stop
  const audioCaptureDoneRef = useRef(false);
  // Manual Finish owns its own capture + local draft save so a force-stop after
  // "Recording Complete" can recover the draft instead of racing the effect path.
  const manualFinishSlotIdRef = useRef<string | null>(null);
  // Guard: track which slot IDs are actively uploading to prevent double-submission
  // across React render batches (useRef is synchronous; useState is not).
  const uploadingSlotIdsRef = useRef<Set<string>>(new Set());
  // Guard: a slot marked for submission may still finish its deferred local draft save,
  // but it must not create a new server-side draft row while upload is in flight.
  const submitIntentSlotIdsRef = useRef<Set<string>>(new Set());
  // A controlled restart and background draft creation must never overlap:
  // each would reserve a different server identity for the same local audio.
  const draftSyncInFlightSlotIdsRef = useRef<Set<string>>(new Set());
  const draftSyncPromiseBySlotRef = useRef<Map<string, Promise<void>>>(new Map());
  // Phase-1 local saves also own a slot snapshot. Serialize them per slot and
  // let identity rotation wait for the complete tail before writing a new key.
  const localDraftSavePromiseBySlotRef = useRef<Map<string, Promise<boolean>>>(new Map());
  const isSlotUploadActive = useCallback((slotId: string): boolean => {
    // A Submit All batch freezes the entire session — even a slot NOT in the
    // batch must not be mutated, because the batch's success path resets the
    // whole session and would discard it (Codex P1, PR #143).
    if (isSubmittingAllRef.current) return true;
    if (uploadingSlotIdsRef.current.has(slotId)) return true;
    if (uploadRestartSlotIdsRef.current.has(slotId)) return true;
    // Slots queued behind the current upload in a Submit All batch exist only
    // in submitIntentSlotIdsRef (uploadStatus still 'pending'), yet the batch
    // loop holds a snapshot of them. With the overlay hidden they must be as
    // locked as the actively-uploading slot — otherwise continue/edit/delete
    // on a queued slot makes the loop upload stale audio or files the UI just
    // deleted (Codex P1, PR #143).
    if (submitIntentSlotIdsRef.current.has(slotId)) return true;
    // A reconciliation transaction owns this slot's draft, audio files, and
    // durable manifest for seconds at a time. Locking only the divergence
    // buttons left the ordinary controls live, so "Delete & Start Over" could
    // begin replacement work mid-cleanup — after which the old transaction
    // resumes, marks the slot successful, and runs the deferred reset over the
    // new audio.
    if (reconcilingSlotIdRef.current === slotId) return true;
    return sessionRef.current.slots.some(
      (slot) => slot.id === slotId && slot.uploadStatus === 'uploading',
    );
  }, []);
  // Guard: if upload wins the race against deferred local draft persistence, auto-save
  // must immediately clean up the late draft instead of leaving it behind locally.
  const completedUploadSlotIdsRef = useRef<Set<string>>(new Set());
  /**
   * The reset+navigate a completed submit deferred because a divergence
   * notice still needed to be read. Held as a closure so the resumption uses
   * the ORIGINAL transition — single submit goes to its detail, Submit All to
   * the list — instead of re-deriving it from stale state.
   */
  const deferredSuccessTransitionRef = useRef<(() => void) | null>(null);
  /**
   * The slot whose reconciliation transaction is running. Both actions take
   * seconds (a file copy, SecureStore writes, a native purge) while their
   * buttons stay on screen, and they mutate the same draft, the same copy URI,
   * and the same manifest — so a second tap, or the other action, would run
   * concurrently against half-applied state. State drives the disabled UI; the
   * ref is the synchronous gate, since a tap can land before React re-renders.
   */
  const [reconcilingSlotId, setReconcilingSlotId] = useState<string | null>(null);
  const reconcilingSlotIdRef = useRef<string | null>(null);
  /**
   * Bumped whenever a reconciliation transaction starts OR is abandoned. A
   * transaction captures the value and stops before every destructive step once
   * it no longer matches — which is what lets a timeout walk away from a native
   * call it cannot cancel, instead of leaving the UI gated on it forever.
   */
  const reconcileGenerationRef = useRef(0);
  // Set when uploadSlot fails on a network-dead phase that the user should be
  // able to recover from by going online later: transient r2_put exhaustion
  // (Sentry REACT-NATIVE-4: DNS resolve / socket reset after 3 retries) or
  // create_draft network failure (Sentry REACT-NATIVE-C: fetch() throws
  // `Network request failed` while POSTing the draft row or validating an
  // existing one). Read by handleSubmitSingle / handleSubmitAll after
  // uploadSlot returns null so they can fall through to auto-stash instead of
  // leaving the user staring at a generic "upload failed" alert with no
  // recovery path. Value carries the AutoStashReason so the analytics event
  // can attribute which phase triggered the rescue.
  const autoStashableFailuresRef = useRef<Map<string, AutoStashReason>>(new Map());
  // Per-slot timers for debounced server-draft creation. Server POST
  // /api/recordings {isDraft:true} runs after DRAFT_DEBOUNCE_MS; if the user
  // taps Submit first, the timer is cancelled so no draft row ever exists to
  // orphan. On stash, pending timers are flushed synchronously so the Home
  // "Not Submitted" card still appears. Empty map = debounce disabled or no
  // pending syncs.
  const pendingDraftTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Suppress the next stopped-audio capture when the current segment is being discarded.
  const skipNextAudioCaptureRef = useRef(false);
  const recordingSegmentStartedAtMsRef = useRef<number | null>(null);
  const recorderStateRef = useRef(recorder.state);
  recorderStateRef.current = recorder.state;
  const recorderStopRef = useRef(recorder.stop);
  recorderStopRef.current = recorder.stop;

  const cancelScheduledDraft = useCallback((slotId: string) => {
    const timer = pendingDraftTimersRef.current.get(slotId);
    if (timer) {
      clearTimeout(timer);
      pendingDraftTimersRef.current.delete(slotId);
    }
  }, []);

  const markSubmitIntent = useCallback((slotIds: string[]) => {
    slotIds.forEach((slotId) => {
      submitIntentSlotIdsRef.current.add(slotId);
      completedUploadSlotIdsRef.current.delete(slotId);
      // Kill any pending server-draft creation so the upload below doesn't
      // race against a just-written draft row.
      cancelScheduledDraft(slotId);
    });
    setSubmitIntentCount(submitIntentSlotIdsRef.current.size);
  }, [cancelScheduledDraft]);

  const clearSubmitIntent = useCallback((slotIds: string[]) => {
    slotIds.forEach((slotId) => {
      submitIntentSlotIdsRef.current.delete(slotId);
    });
    setSubmitIntentCount(submitIntentSlotIdsRef.current.size);
  }, []);

  const markUploadRestart = useCallback((slotId: string) => {
    uploadRestartSlotIdsRef.current.add(slotId);
    setUploadRestartCount(uploadRestartSlotIdsRef.current.size);
  }, []);

  const clearUploadRestart = useCallback((slotId: string) => {
    uploadRestartSlotIdsRef.current.delete(slotId);
    setUploadRestartCount(uploadRestartSlotIdsRef.current.size);
  }, []);

  const hasBlockingUploadWork = useCallback(
    () =>
      isSubmittingAllRef.current ||
      submitIntentSlotIdsRef.current.size > 0 ||
      uploadRestartSlotIdsRef.current.size > 0 ||
      uploadingSlotIdsRef.current.size > 0,
    [],
  );

  const buildPersistedSlot = useCallback(
    (slotId: string, snapshot: PersistableRecorderSnapshot): PatientSlot | null => {
      if (!snapshot.audioUri) return null;
      const slot = sessionRef.current.slots.find((s) => s.id === slotId);
      if (!slot) return null;
      const newSegment = {
        uri: snapshot.audioUri,
        duration: snapshot.duration,
        peakMetering: typeof snapshot.maxMetering === 'number' ? snapshot.maxMetering : undefined,
      };
      return {
        ...slot,
        segments: [...slot.segments, newSegment],
        audioUri: snapshot.audioUri,
        audioDuration: slot.segments.reduce((sum, seg) => sum + seg.duration, 0) + snapshot.duration,
        audioState: 'stopped',
      };
    },
    []
  );

  // Clear any pending debounce timers on unmount so they don't fire against a
  // dead component (and because the user navigating away from Record = intent
  // to keep the session as a local-only draft, not push a server row).
  useEffect(() => {
    const timers = pendingDraftTimersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      deactivateKeepAwake(RECORDING_KEEP_AWAKE_TAG).catch(() => {});
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!user?.id) {
      setPreferredTemplateId(null);
      return;
    }
    setPreferredTemplateId(undefined);
    templatePreference
      .getDefaultTemplateId(user.id)
      .then((templateId) => {
        if (!cancelled) setPreferredTemplateId(templateId);
      })
      .catch(() => {
        if (!cancelled) setPreferredTemplateId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  const handleSetDefaultTemplate = useCallback(
    async (templateId: string) => {
      if (!user?.id) return;
      setDefaultTemplateSavingId(templateId);
      try {
        const saved = await templatePreference.setDefaultTemplateId(user.id, templateId);
        if (!saved) {
          Alert.alert(TEMPLATE_DEFAULT_COPY.saveFailed.title, TEMPLATE_DEFAULT_COPY.saveFailed.body);
          return;
        }
        setPreferredTemplateId(templateId);
        const template = templates.find((item) => item.id === templateId);
        trackEvent({
          name: 'template_default_set',
          props: { template_kind: template?.isDefault ? 'org_default' : 'custom' },
        });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      } finally {
        setDefaultTemplateSavingId(null);
      }
    },
    [templates, user?.id]
  );

  // Auto-select default template for first slot once templates + user pref load
  useEffect(() => {
    if (templatesLoading || preferredTemplateId === undefined) return;
    if (
      effectiveDefaultTemplate &&
      session.slots.length === 1 &&
      !session.slots[0].formData.templateId &&
      !uploadRestartSlotIdsRef.current.has(session.slots[0].id)
    ) {
      updateForm(session.slots[0].id, 'templateId', effectiveDefaultTemplate.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only run when defaultTemplate loads, not on every slot/form change
  }, [templatesLoading, preferredTemplateId, effectiveDefaultTemplate?.id]);

  // Effect: capture audio URI when recorder transitions to stopped while bound to a slot
  useEffect(() => {
    let timerId: ReturnType<typeof setTimeout> | null = null;

    if (recorder.state !== 'stopped') {
      // Reset guard when recorder leaves stopped state (e.g. after reset → new recording)
      audioCaptureDoneRef.current = false;
      return () => { if (timerId) clearTimeout(timerId); };
    }
    if (recorder.isStarting) {
      return () => { if (timerId) clearTimeout(timerId); };
    }
    if (manualFinishSlotIdRef.current && manualFinishSlotIdRef.current === session.recorderBoundToSlotId) {
      return () => { if (timerId) clearTimeout(timerId); };
    }
    if (skipNextAudioCaptureRef.current && !audioCaptureDoneRef.current) {
      audioCaptureDoneRef.current = true;
      skipNextAudioCaptureRef.current = false;
      // This is the single choke point for every DELIBERATE discard — both
      // discardCurrentSession and the active-slot Remove flow set the skip flag,
      // stop the recorder and land here, bypassing the normal capture-done
      // cleanup below. The capture pointer must go with them: a user who chose
      // to throw a recording away must never be told on the next launch that
      // Android killed the app and lost their audio.
      //
      // Both ids are cleared because a slot recording durably has no
      // `slot.durable` yet (it is set in the finish branch), so the discard
      // loop's own cleanup cannot reach a still-live durable capture.
      const discardedSlotId = session.recorderBoundToSlotId;
      const discardedDurableId = recorder.activeDurableRecordingId;
      if (discardedSlotId) durableActiveStore.clearActive(discardedSlotId).catch(() => {});
      if (discardedDurableId) durableActiveStore.clearActive(discardedDurableId).catch(() => {});
      unbindRecorder();
      recorder.reset();
      return () => { if (timerId) clearTimeout(timerId); };
    }
    // Durable capture finish: audio lives in audio.aac (no audioUri). Convert the
    // snapshot into the slot's durable ref and arm the draft save, rather than
    // falling into the segment/null-audioUri branches (the latter would show a
    // false "Recording Error" because durable produces no URI).
    if (recorder.activeDurableRecordingId && session.recorderBoundToSlotId && !audioCaptureDoneRef.current) {
      audioCaptureDoneRef.current = true;
      const slotId = session.recorderBoundToSlotId;
      const snap = recorder.getDurableSnapshot();
      if (snap) {
        setDurableRecording(slotId, {
          recordingId: snap.recordingId,
          codec: 'aac_lc',
          sampleRate: snap.sampleRate,
          bitrate: snap.bitrate,
          durationMs: snap.durationMs,
          peakDb: snap.peakDb,
        });
        pendingDraftSlotIdRef.current = slotId;
        pendingDraftMinSegmentCountRef.current = 0;
        pendingDraftRecoveryReasonRef.current.set(slotId, 'draft_finish');
        // Clean finish — clear the "was recording at exit" active pointer.
        durableActiveStore.clearActive(snap.recordingId).catch(() => {});
      } else {
        unbindRecorder();
      }
      recordingSegmentStartedAtMsRef.current = null;
      if (pendingStashRef.current) {
        recorder.resetWithoutDelete();
      } else if (pendingStartSlotQueueRef.current.length > 0) {
        const nextSlotId = pendingStartSlotQueueRef.current.shift()!;
        setQueuedStartSlotIds((ids) => ids.filter((id) => id !== nextSlotId));
        recorder.resetWithoutDelete();
        timerId = setTimeout(() => {
          startRecordingRef.current(nextSlotId);
        }, 250);
      } else {
        recorder.resetWithoutDelete();
      }
      return () => { if (timerId) clearTimeout(timerId); };
    }
    if (recorder.audioUri && session.recorderBoundToSlotId && !audioCaptureDoneRef.current) {
      audioCaptureDoneRef.current = true;
      const slotId = session.recorderBoundToSlotId;
      const audioUri = recorder.audioUri;
      const snapshot: PersistableRecorderSnapshot = {
        audioUri,
        duration: recorder.duration,
        maxMetering: recorder.maxMetering,
      };
      const persistedSlot = buildPersistedSlot(slotId, snapshot);
      saveAudio(
        slotId,
        audioUri,
        snapshot.duration,
        snapshot.maxMetering
      );
      pendingDraftSlotIdRef.current = persistedSlot ? slotId : null;
      pendingDraftMinSegmentCountRef.current = persistedSlot?.segments.length ?? 0;
      if (persistedSlot) {
        pendingDraftRecoveryReasonRef.current.set(slotId, 'draft_finish');
      }
      // Segment captured and finalized — this was a clean exit for the expo path.
      durableActiveStore.clearActive(slotId).catch(() => {});
      recordingSegmentStartedAtMsRef.current = null;

      // If there's a pending stash, just reset the recorder here.
      // Don't call executeStash() yet — saveAudio dispatch hasn't been processed,
      // so `session` still has 0 segments. A separate effect fires executeStash
      // on the next render after SAVE_AUDIO updates the session state.
      if (pendingStashRef.current) {
        recorder.resetWithoutDelete();
      } else if (pendingStartSlotQueueRef.current.length > 0) {
        // Pop the head of the queue. Subsequent queued slots will be drained
        // on later stop cycles — one stop, one start.
        const nextSlotId = pendingStartSlotQueueRef.current.shift()!;
        setQueuedStartSlotIds((ids) => ids.filter((id) => id !== nextSlotId));
        recorder.resetWithoutDelete();
        timerId = setTimeout(() => {
          startRecordingRef.current(nextSlotId);
        }, 250);
      } else {
        recorder.resetWithoutDelete();
      }
    } else if (!recorder.audioUri && session.recorderBoundToSlotId && !audioCaptureDoneRef.current) {
      // Null audioUri — native pause/stop both failed. Clean up the dead binding.
      audioCaptureDoneRef.current = true;
      const boundSlotId = session.recorderBoundToSlotId;
      const boundSlot = session.slots.find((s) => s.id === boundSlotId);
      unbindRecorder();
      // Native capture failed outright. The process is alive and handled it, so
      // this is not an OS kill — drop the pointer or next launch misreports it.
      durableActiveStore.clearActive(boundSlotId).catch(() => {});
      recordingSegmentStartedAtMsRef.current = null;

      if (boundSlot) {
        setAudioState(boundSlotId, boundSlot.segments.length > 0 ? 'stopped' : 'idle');
      }

      if (pendingStashRef.current) {
        // Native recorder failed to produce audio. The deferred stash effect will
        // still fire (unbindRecorder makes recorderBoundToSlotId null). It will stash
        // any previously-saved segments, but this recording is lost.
        recorder.reset();
        Alert.alert(
          'Recording Error',
          'The current recording could not be captured. Any previously saved segments will still be stashed.'
        );
      } else if (pendingStartSlotQueueRef.current.length > 0) {
        const nextSlotId = pendingStartSlotQueueRef.current.shift()!;
        setQueuedStartSlotIds((ids) => ids.filter((id) => id !== nextSlotId));
        recorder.resetWithoutDelete();
        timerId = setTimeout(() => {
          startRecordingRef.current(nextSlotId);
        }, 250);
      } else {
        recorder.reset();
      }
    }

    return () => { if (timerId) clearTimeout(timerId); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally depends only on recorder state transitions, not on session/slot refs which would cause infinite loops
  }, [recorder.state, recorder.isStarting, recorder.audioUri, recorder.duration, recorder.maxMetering, recorder.activeDurableRecordingId, saveAudio, buildPersistedSlot, setDurableRecording]);

  // Keep the multi-patient record-first warning scoped to the current active
  // appointment. A reset or clean single-patient return should warn again later.
  useEffect(() => {
    const isCleanSinglePatientSession =
      session.slots.length === 1 &&
      !hasUnsavedRecordings &&
      session.recorderBoundToSlotId === null;
    if (isCleanSinglePatientSession) {
      multiPatientRecordFirstWarningShownRef.current = false;
    }
  }, [hasUnsavedRecordings, session.recorderBoundToSlotId, session.slots.length]);

  // Consistency guard: heal orphaned recording/paused states whenever slots change.
  //
  // A race between a successful startRecordingForSlot resolving setAudioState('recording')
  // and a concurrent invocation's catch dispatching unbindRecorder can leave a slot in
  // 'recording' state without ownership. UI then shows the "Ready to Record" badge with
  // the Start button permanently disabled (canStartRecording requires audioState='idle').
  // Watching session.slots here heals that state on the next render — Fix #2 prevents the
  // race at the source, this is defense in depth for any future similar path.
  useEffect(() => {
    session.slots.forEach((slot) => {
      if (slot.id === session.recorderBoundToSlotId) return;
      if (slot.audioState === 'recording' || slot.audioState === 'paused') {
        // A durable slot has empty segments but its audio lives in audio.aac —
        // heal to 'stopped' referencing the durable recordingId, never 'idle'
        // (which would drop the audio from session state). Plan: durable orphan
        // consistency guard.
        const nextState = slot.segments.length > 0 || slot.durable ? 'stopped' : 'idle';
        breadcrumb('record', 'orphan_state_healed', {
          from: slot.audioState,
          to: nextState,
          has_segments: slot.segments.length > 0,
        });
        setAudioState(slot.id, nextState);
      }
    });
  }, [session.recorderBoundToSlotId, session.slots, setAudioState]);

  // Publish recorder ownership to the module-level recordingActivity flag so
  // RecordingAudioPlayer (detail screen) won't reconfigure the audio session
  // out of recording mode while a session is live (1C collision guard). The
  // Record tab stays mounted across navigations, so this effect is the single
  // authoritative writer; cleanup covers unmount mid-recording.
  useEffect(() => {
    recordingActivity.setActive(session.recorderBoundToSlotId !== null);
    return () => {
      recordingActivity.setActive(false);
    };
  }, [session.recorderBoundToSlotId]);

  // Effect: handle audio session interruptions (incoming call, Siri, headphones).
  //
  // The hook flushes whatever bytes it captured to a partial segment file and
  // flips to `'interrupted'`. We commit that segment to the slot via the same
  // multi-segment path used by manual pause-then-continue, reset the recorder
  // to idle, and arm `interruptionPendingResume` so the AppState handler picks
  // up resumption when the user returns from the call. The slot's audioState
  // ends at `'idle'` (CONTINUE_RECORDING) so the new segment slots in cleanly
  // when recording starts again.
  useEffect(() => {
    if (recorder.state !== 'interrupted') return;
    if (interruptionPendingResume) return; // already handled this transition
    const slotId = session.recorderBoundToSlotId;
    if (!slotId) {
      // No bound slot — there's nothing to save. Just clear the recorder.
      recorder.resetWithoutDelete();
      return;
    }
    // Durable interruption: audio.aac is already durably saved + marked
    // interrupted natively. v1 does NOT auto-resume-append (that needs the
    // multi-segment AAC path); instead finish the recording as a submittable
    // durable draft so nothing is orphaned. The user submits or re-records.
    if (recorder.activeDurableRecordingId) {
      audioCaptureDoneRef.current = true;
      const snap = recorder.getDurableSnapshot();
      if (snap) {
        setDurableRecording(slotId, {
          recordingId: snap.recordingId,
          codec: 'aac_lc',
          sampleRate: snap.sampleRate,
          bitrate: snap.bitrate,
          durationMs: snap.durationMs,
          peakDb: snap.peakDb,
        });
        pendingDraftSlotIdRef.current = slotId;
        pendingDraftMinSegmentCountRef.current = 0;
        pendingDraftRecoveryReasonRef.current.set(slotId, 'draft_finish');
        durableActiveStore.clearActive(snap.recordingId).catch(() => {});
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      breadcrumb('record', 'durable_interruption_finished', { slot_id: slotId });
      // Explain the silent finalize: the card flips from "Recording…" to
      // "Recording Complete" with no other cue, mid-exam.
      setDurableInterruptionNotice(true);
      announceForIOS(RECORDER_TRANSITION_COPY.interruptedSaved);
      recorder.resetWithoutDelete();
      return;
    }
    if (recorder.audioUri) {
      // Skip the next 'stopped'-driven autosave: the hook calls stop() inside
      // its interruption handler, which would otherwise double-fire the audio
      // capture effect against this same URI.
      audioCaptureDoneRef.current = true;
      saveAudio(slotId, recorder.audioUri, recorder.duration, recorder.maxMetering);
      dispatch({ type: 'CONTINUE_RECORDING', slotId });
      // The segment is finalized on disk and the interruption was HANDLED, so
      // this is a clean exit for the pointer — mirroring the durable branch
      // above, which already clears snap.recordingId. Without it, a user who
      // submits the partial segment instead of resuming gets a false
      // capture_ended_without_cleanup on their next launch. Resuming simply writes
      // the pointer again under the same slot key.
      durableActiveStore.clearActive(slotId).catch(() => {});
    }
    setInterruptionPendingResume({ slotId });
    interruptionPendingResumeRef.current = { slotId };
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    breadcrumb('record', 'interruption_paused', { slot_id: slotId });
    // The banner below is Android-only via accessibilityLiveRegion; announce
    // explicitly so iOS VoiceOver users hear the pause too (iOS-gated to avoid
    // a double announcement on Android).
    announceForIOS(RECORDER_TRANSITION_COPY.interruptedPaused);
    recorder.resetWithoutDelete();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally fires only on the recorder transition; reading session/refs from current render is correct
  }, [recorder.state]);

  // A fresh recording supersedes the durable-interruption explainer.
  useEffect(() => {
    if (recorder.state === 'recording') setDurableInterruptionNotice(false);
  }, [recorder.state]);

  // Announce recorder transitions for screen readers. The on-card badges use
  // accessibilityLiveRegion, which is Android-only — iOS VoiceOver users got
  // no feedback that recording started/paused/resumed/finished (WP29).
  const prevRecorderStateRef = useRef(recorder.state);
  useEffect(() => {
    const prev = prevRecorderStateRef.current;
    const next = recorder.state;
    prevRecorderStateRef.current = next;
    if (prev === next) return;
    if (next === 'recording') {
      announceForIOS(prev === 'paused' ? 'Recording resumed' : 'Recording started');
    } else if (next === 'paused') {
      announceForIOS('Recording paused');
    } else if (next === 'stopped' && (prev === 'recording' || prev === 'paused')) {
      announceForIOS('Recording finished');
    }
  }, [recorder.state]);

  // Android audio-focus interruption bridge.
  //
  // expo-audio on Android does not surface AudioFocus loss as `hasError`
  // because its background-audio foreground service holds focus across the
  // call. To detect calls / alarms / voice apps, the local
  // `captivet-audio-focus` native module registers our own focus listener
  // via AudioManager. On loss, we hand off to the hook's shared
  // `triggerInterruption()` flow, which transitions the recorder state to
  // 'interrupted' — the existing `recorder.state === 'interrupted'` effect
  // above then saves the partial segment, shows the banner, and arms
  // pending-resume. iOS already gets this via expo-audio's hasError, and
  // the native module is a no-op on that platform.
  const recorderStateForFocusRef = useRef(recorder.state);
  recorderStateForFocusRef.current = recorder.state;
  const triggerInterruptionRef = useRef(recorder.triggerInterruption);
  triggerInterruptionRef.current = recorder.triggerInterruption;
  // Durable capture handles audio-focus loss inside its own native module and
  // emits `interruption` (consumed by the hook). Don't ALSO react via the
  // captivet-audio-focus listener, or the same loss gets double-handled.
  const durableActiveRef = useRef<string | null>(recorder.activeDurableRecordingId);
  durableActiveRef.current = recorder.activeDurableRecordingId;
  useEffect(() => {
    const sub = audioFocus.addListener((event) => {
      if (event.type === 'loss') {
        if (durableActiveRef.current) return; // durable module owns this
        if (event.reason === 'duck') return; // ducking is volume-only, not pause
        if (interruptionPendingResumeRef.current) return; // already handling
        const state = recorderStateForFocusRef.current;
        if (state !== 'recording' && state !== 'paused') return;
        triggerInterruptionRef.current().catch(() => {});
        return;
      }
      if (event.type === 'gain') {
        // Gain fires when the interrupting source releases focus (call
        // declined / timed out, alarm dismissed, voice app finished). If the
        // app got backgrounded during the interruption, defer to the
        // AppState 'active' handler instead — it adds the same 500ms delay
        // for AVAudioSession warmup on iOS and avoids a double-resume race.
        if (!interruptionPendingResumeRef.current) return;
        if (appStateRef.current !== 'active') return;
        const resume = interruptionPendingResumeRef.current;
        interruptionPendingResumeRef.current = null;
        setTimeout(() => {
          try {
            startRecordingRef.current(resume.slotId);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
            breadcrumb('record', 'interruption_resumed', { slot_id: resume.slotId, source: 'audio_focus' });
          } catch (e) {
            if (__DEV__) console.error('[Record] focus-gain auto-resume failed', e);
          } finally {
            setInterruptionPendingResume(null);
          }
        }, 500);
      }
    });
    return () => {
      sub.remove();
    };
  }, []);

  // Hold the legacy expo-recorder audio-focus listener while a non-durable slot
  // is active, and also while we're in the post-interruption pending-resume
  // window so we don't miss the GAIN event when a call/alarm releases focus.
  useEffect(() => {
    const durableActive = !!recorder.activeDurableRecordingId;
    const isActive = !durableActive && (recorder.state === 'recording' || recorder.state === 'paused');
    const hasPendingResume = !!interruptionPendingResumeRef.current;
    if (isActive || hasPendingResume) {
      audioFocus.startMonitoring().catch(() => {});
    } else {
      audioFocus.stopMonitoring().catch(() => {});
    }
  }, [recorder.state, recorder.activeDurableRecordingId, interruptionPendingResume]);

  // NO periodic interval checkpoint. We deliberately never stop the live
  // recorder mid-exam. The previous "flush a durable segment every 5 min"
  // timer (commit 7889744) tore down and recreated the native MediaRecorder,
  // which on real tablets (verified SM-T220, 2026-06-02) produced a ~1.1s
  // mic-capture gap — the "recording pauses at 5/10 min" staff reports — and
  // split one continuous recording into multiple segments, dropping ~1s of
  // audio at each boundary. The fire time also drifted (timer re-armed on
  // every dep change), so it landed at 5 OR 10 min unpredictably.
  //
  // Durability across screen-lock / app-switch comes from
  // persistSessionDraftsForBackground (which persists already-captured
  // segments WITHOUT stopping the recorder) plus the OS keeping the recorder
  // alive via the Android foreground-service mic + iOS background-audio mode.
  // The live recording stays owned by expo-audio until the user taps Finish.

  useEffect(() => {
    const shouldStayAwake = recorder.state === 'recording';
    if (!shouldStayAwake) {
      deactivateKeepAwake(RECORDING_KEEP_AWAKE_TAG).catch(() => {});
      return;
    }

    activateKeepAwakeAsync(RECORDING_KEEP_AWAKE_TAG).catch(() => {});
    return () => {
      deactivateKeepAwake(RECORDING_KEEP_AWAKE_TAG).catch(() => {});
    };
  }, [recorder.state]);

  const persistSessionDraftsForBackground = useCallback(async () => {
    if (backgroundPersistingRef.current) return;
    backgroundPersistingRef.current = true;

    try {
      // Intentionally do NOT stop the live recorder here. With iOS
      // UIBackgroundModes=["audio"] + the Android foreground-service
      // microphone permission, the OS keeps the recorder alive through
      // screen lock and app-switch. We only persist drafts for slots
      // that already have captured segments — the live recording stays
      // owned by expo-audio until the user taps Finish. Include finished durable
      // slots (empty segments, audio in audio.aac): without this, backgrounding
      // right after Finish can lose the patient/client metadata on a kill (the
      // durable audio recovers, but with no form data) — durable finish must get
      // the same restart protection as segment recordings.
      // ...plus a succeeded slot holding a retained copy for an unresolved
      // identity divergence: it is exactly the copy that must survive a kill.
      const slotsToPersist = sessionRef.current.slots.filter(
        (slot) =>
          slotHasRecoverableAudio(slot) &&
          (slot.uploadStatus !== 'success' ||
            slot.metadataDivergence?.tier === 'identity')
      );

      await Promise.all(
        slotsToPersist.map((slot) => autoSaveDraftRef.current(slot).catch(() => {}))
      );
    } catch (error) {
      if (__DEV__) console.error('[Record] background draft persist failed:', error);
    } finally {
      backgroundPersistingRef.current = false;
    }
  }, []);

  const discardCurrentSession = useCallback(async (opts?: { preserveDraftSlotIds?: string[] }) => {
    // Callers that are about to load a draft (or that want to keep other
    // Home-visible drafts alive) pass their ids here so the cleanup loop
    // below doesn't silently delete the very rows the next step relies on.
    const preserve = new Set(opts?.preserveDraftSlotIds ?? []);
    const durableUserId = user?.id;

    pendingStartSlotQueueRef.current = [];
    setQueuedStartSlotIds([]);
    pendingStashRef.current = false;
    // Cancel every slot's scheduled server-draft debounce timer. Without this
    // cleanup, a timer queued before the user tapped "Load Draft" / "Discard"
    // fires 5s later and creates a ghost server-draft row for a session the
    // user has already abandoned — surfacing as an orphan "Not Submitted"
    // card on Home that the sweep can't associate back to any local audio.
    session.slots.forEach((slot) => cancelScheduledDraft(slot.id));

    const shouldResetRecorder =
      session.recorderBoundToSlotId !== null ||
      recorder.audioUri !== null ||
      recorder.state === 'recording' ||
      recorder.state === 'paused' ||
      recorder.state === 'stopped';

    if (shouldResetRecorder) {
      skipNextAudioCaptureRef.current = true;
      // Captured BEFORE stop/unbind/reset erase them. The stopped-state effect's
      // skip branch cannot be relied on here: unbindRecorder() and
      // recorder.reset() run synchronously below, so by the time that effect
      // renders, recorderBoundToSlotId and activeDurableRecordingId are already
      // null and it would clear nothing. A deliberate discard must never be
      // reported as an OS kill on the next launch.
      const discardedSlotId = session.recorderBoundToSlotId;
      const discardedDurableId = recorder.activeDurableRecordingId;
      if (recorder.state === 'recording' || recorder.state === 'paused') {
        try {
          await recorder.stop();
        } catch {
          // stop() already performs internal cleanup
        }
      }
      if (discardedSlotId) durableActiveStore.clearActive(discardedSlotId).catch(() => {});
      if (discardedDurableId) durableActiveStore.clearActive(discardedDurableId).catch(() => {});
      unbindRecorder();
      recorder.reset();
    }

    session.slots.forEach((slot) => {
      slot.segments.forEach((seg) => {
        // Post-PROMOTE_SEGMENTS_TO_DRAFT, segment URIs may live under the draft
        // directory. Those files are owned by draftStorage; deleteSlotDraft
        // (below) is the authoritative deleter. Calling safeDeleteFile here
        // would race with draftStorage's own cleanup and could leave a half-
        // deleted draft on disk if the user re-resumes from a stash that
        // captured the same URIs.
        if (!isDraftOwnedUri(seg.uri)) {
          safeDeleteFile(seg.uri);
        }
      });
      // Delete the auto-saved draft (local + server) and any mid-confirm
      // server recording so the discarded work doesn't linger as a "Not
      // Submitted" row on Home — unless the caller asked us to keep the
      // draft (e.g. resume-from-Home is about to load it). The orphan
      // server-recording delete MUST stay inside this preserve gate: a
      // preserved draft's pendingConfirm points at that server row, and for
      // proof-only recovery drafts with no local audio the upload can never
      // be restarted once the row is gone (Codex P1, PR #143).
      if (!slot.draftSlotId || !preserve.has(slot.draftSlotId)) {
        deleteOrphanServerRecording(slot);
        // A FINISHED durable slot keeps its audio in the native audio.aac; the
        // recorder.reset() above only discards the still-BOUND live recorder, so
        // an unbound finished durable slot would survive on disk and the launch
        // recovery scan could re-offer a recording the user explicitly discarded.
        // Discard its native recording + any loose recovered .aac copy here.
        if (slot.durable) {
          if (durableUserId) {
            durableRecorder
              .discard({ userId: durableUserId, recordingId: slot.durable.recordingId })
              .catch(() => {});
          }
          durableActiveStore.clearActive(slot.durable.recordingId).catch(() => {});
          if (slot.durable.recoveredAudioUri) safeDeleteFile(slot.durable.recoveredAudioUri);
        }
        deleteSlotDraft(slot);
      }
    });

    // Release the pinned stash (if any) so the SecureStore entry and audio dir
    // are fully cleaned up. Must run before resetSession — after reset the
    // segment refs are gone, but releaseResumedStash works off the stored id.
    releaseResumedStashIfAny();

    unsyncedDraftAudioRef.current.clear();
    stashResumedSlotIdsRef.current.clear();
    resetSession();
  }, [session.slots, session.recorderBoundToSlotId, recorder, unbindRecorder, resetSession, releaseResumedStashIfAny, deleteOrphanServerRecording, deleteSlotDraft, cancelScheduledDraft, user?.id]);

  // Navigation guard: only active when there are truly unsaved recordings.
  // Drafted slots (draftSlotId set) are durable on disk + server and survive
  // discard via the preserve list below, so they don't arm the guard —
  // UNLESS their newest audio is still waiting on autoSaveDraft (see
  // unsyncedDraftAudioRef).
  const isSlotTrulyUnsaved = useCallback(
    (s: PatientSlot): boolean =>
      isTrulyUnsavedSlot(s) ||
      (slotHasRecoverableAudio(s) &&
        s.uploadStatus !== 'success' &&
        (unsyncedDraftAudioRef.current.has(s.id) || pendingDraftSlotIdRef.current === s.id)),
    []
  );
  const unsavedCount = session.slots.filter(isSlotTrulyUnsaved).length;
  const draftedSlotCount = session.slots.filter((s) => s.draftSlotId).length;

  usePreventRemove(unsavedCount > 0 && !isSubmittingAll, ({ data }) => {
    Alert.alert(
      DISCARD_SESSION_COPY.title,
      draftedSlotCount > 0
        ? DISCARD_SESSION_COPY.bodyWithDrafts(unsavedCount)
        : DISCARD_SESSION_COPY.body(unsavedCount),
      [
        { text: DISCARD_SESSION_COPY.stay, style: 'cancel' },
        {
          text: DISCARD_SESSION_COPY.discard,
          style: 'destructive',
          onPress: () => {
            (async () => {
              await discardCurrentSession({
                preserveDraftSlotIds: collectPreserveDraftSlotIds(
                  sessionRef.current.slots,
                  stashResumedSlotIdsRef.current
                ),
              });
              navigation.dispatch(data.action);
            })().catch(() => {});
          },
        },
      ]
    );
  });

  // Sync pager with active index (skip when change came from a swipe — FlatList is already there)
  useEffect(() => {
    if (swipeChangeRef.current) {
      swipeChangeRef.current = false;
      return;
    }
    if (!isScrollingRef.current && pagerRef.current) {
      pagerRef.current.scrollToIndex({
        index: session.activeIndex,
        animated: true,
      });
    }
  }, [session.activeIndex]);

  // Shared tab/swipe selection: if leaving a live recording, park it first so
  // returning to that patient exposes Resume instead of hiding an active owner.
  const selectPatientIndex = useCallback(
    (index: number, opts?: { fromSwipe?: boolean }) => {
      if (index === session.activeIndex) return;
      Haptics.selectionAsync().catch(() => {});
      const leavingSlotId = session.recorderBoundToSlotId;
      if (leavingSlotId && recorder.state === 'recording') {
        const leavingSlot = session.slots.find((s) => s.id === leavingSlotId);
        const patientLabel =
          leavingSlot?.formData.patientName?.trim() ||
          `Patient ${session.slots.findIndex((s) => s.id === leavingSlotId) + 1}`;
        (async () => {
          try {
            await recorder.pause();
            setAudioState(leavingSlotId, 'paused');
            // Visible + spoken feedback — the auto-pause is otherwise silent
            // (haptic only) and a vet could keep talking while nothing records.
            // The Toast host owns the announcement (iOS-gated announce +
            // Android live region), so no explicit call here — that would
            // double-speak on both platforms (Codex P2, PR #143).
            const message = RECORDER_TRANSITION_COPY.autoPaused(patientLabel);
            setPauseToast(message);
          } catch {
            try { await recorder.stop(); } catch {}
          }
        })().catch(() => {});
      }
      if (opts?.fromSwipe) swipeChangeRef.current = true;
      setActiveIndex(index);
    },
    [session.activeIndex, session.recorderBoundToSlotId, session.slots, recorder, setActiveIndex, setAudioState]
  );

  const handleScrollEnd = useCallback(
    (e: { nativeEvent: { contentOffset: { x: number } } }) => {
      isScrollingRef.current = false;
      const newIndex = Math.round(e.nativeEvent.contentOffset.x / screenWidth);
      const clampedIndex = Math.max(0, Math.min(newIndex, session.slots.length - 1));
      selectPatientIndex(clampedIndex, { fromSwipe: true });
    },
    [screenWidth, selectPatientIndex, session.slots.length]
  );

  const handleScrollBegin = useCallback(() => {
    isScrollingRef.current = true;
  }, []);

  // -- Recording handlers --

  const handleStart = useCallback(
    (slotId: string) => {
      if (!canRecordAppointments(user?.role)) {
        showRecordPermissionAlert();
        return;
      }
      if (isSlotUploadActive(slotId)) {
        showUploadInProgressAlert();
        return;
      }

      // If another slot owns the recorder, prompt to stop it first
      if (session.recorderBoundToSlotId && session.recorderBoundToSlotId !== slotId) {
        const boundSlot = session.slots.find((s) => s.id === session.recorderBoundToSlotId);
        if (boundSlot) {
          // Actively recording — confirm before stopping
          if (recorder.state === 'recording') {
            Alert.alert(
              'Stop Current Recording?',
              `Stop recording for ${boundSlot.formData.patientName || 'the other patient'} before starting a new one?`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Stop & Start New',
                  onPress: () => {
                    enqueuePendingStart(slotId);
                    (async () => {
                      try {
                        await recorder.stop();
                      } catch {
                        removePendingStart(slotId);
                        Alert.alert('Recording Error', 'Failed to stop the current recording.');
                      }
                    })().catch(() => {});
                  },
                },
              ]
            );
            return;
          }

          // Paused — auto-stop and start new (user already signaled intent to move on)
          if (recorder.state === 'paused') {
            enqueuePendingStart(slotId);
            (async () => {
              try {
                await recorder.stop();
              } catch {
                removePendingStart(slotId);
                Alert.alert('Recording Error', 'Failed to stop the current recording.');
              }
            })().catch(() => {});
            return;
          }
        }
      }

      startRecordingForSlot(slotId);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- startRecordingForSlot accessed via startRecordingRef
    [isSlotUploadActive, session.recorderBoundToSlotId, session.slots, recorder, user?.role]
  );

  const startRecordingForSlot = useCallback(
    (slotId: string) => {
      if (startInFlightRef.current) return;
      startInFlightRef.current = true;
      // Acknowledge the tap on THIS frame, before any await. The haptic and
      // the starting state used to sit behind the floor-hydration await, so on
      // an older tablet the button looked idle — and re-tappable, with the
      // second tap silently swallowed by startInFlightRef — for a visible beat.
      const tappedAtMs = nowMs();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
      setStartingSlotId(slotId);
      // The user who tapped Start. Several awaits (floor hydration, free-space
      // checks, native start) run before the pointer is written, and
      // durableActiveStore can be rebound by a sign-out in that window —
      // setActive captures scope when INVOKED, which is too late here. Verified
      // immediately before each write so A's slot can never land in B's store.
      const initiatingUserId = user?.id ?? null;
      const scopeUnchanged = (): boolean =>
        initiatingUserId !== null && durableActiveStore.getUserId() === initiatingUserId;
      (async () => {
        let resumeDurableRecordingId: string | null = null;
        // Fresh durable start whose pointer write was dispatched alongside the
        // native start, so a failed start can clear it again.
        let freshDurableRecordingId: string | null = null;
        // Expo capture pointer, written before recorder.start(). Cleared in the
        // catch below for the same reason as the durable ids.
        let expoPointerSlotId: string | null = null;
        let startPath: 'durable_start' | 'durable_resume' | 'expo' = 'expo';
        try {
          // Server-enforced min-version floor: block STARTING new capture (fresh or
          // Resume→Continue — every mic start funnels through here) on a build known
          // to be below the floor. Await bounded floor hydration FIRST so an offline
          // cold start can't race past a persisted-but-not-yet-loaded floor.
          // Already-captured audio stays uploadable; unknown floor / unknown current
          // version fails open (allow) — fail-closed only on a KNOWN-below-floor build.
          await measurePhase('record_floor_hydration', undefined, async () => {
            await ensureFloorHydrated();
          }, { warningThresholdMs: null });
          if (getRecordStartGate() === 'block') {
            breadcrumb('record', 'record_start_blocked_min_version', {});
            Alert.alert(
              'Update Required',
              'A newer version of Captivet is required to start new recordings. Please update the app from the store. Recordings you have already captured can still be submitted.',
            );
            return;
          }
          bindRecorder(slotId);
          const startSlot = sessionRef.current.slots.find((s) => s.id === slotId);
          const existingDurable = startSlot?.durable ?? null;
          if (existingDurable) {
            if (!user?.id || !isDurableCaptureEnabled() || !durableRecorder.isAvailable() || existingDurable.recoveredAudioUri) {
              unbindRecorder();
              setAudioState(slotId, 'stopped');
              Alert.alert(
                'Recording Complete',
                'This recording can be submitted as-is. Continuing this recording is not available on this device.',
              );
              return;
            }
            const spaceGate = checkPreRecordFreeSpace();
            if (spaceGate === 'block') {
              unbindRecorder();
              setAudioState(slotId, 'stopped');
              trackEvent({ name: 'durable_low_space_stop', props: { free_bytes: getFreeDiskBytes() ?? undefined } });
              Alert.alert(
                'Not Enough Storage',
                'Your device is too low on free space to continue recording. Free up space (about 250 MB) and try again.',
              );
              return;
            }
            if (spaceGate === 'warn') {
              Alert.alert(
                'Low Storage',
                'Your device is low on free space. The recording may stop early if space runs out — free up space if you can.',
              );
            }
            // The NATIVE start must be gated too, not just the pointer write.
            // The engine is a process singleton, so a capture that begins for a
            // user who has since signed out holds the microphone under the
            // DEPARTED user's directory and rejects the next user's start with
            // BUSY. The unmount teardown cannot rescue it: activeDurableRecordingId
            // is only populated once native start RESOLVES, so a start still in
            // flight is invisible there.
            if (!scopeUnchanged()) {
              unbindRecorder();
              setAudioState(slotId, 'stopped');
              return;
            }
            resumeDurableRecordingId = existingDurable.recordingId;
            startPath = 'durable_resume';
            // Dispatched before, joined after the native resume — see the
            // fresh-start branch below for why.
            // Same scope gate as the expo writes below. setActive binds the
            // store's CURRENT user when invoked, and floor hydration plus the
            // free-space checks above are awaited — so a sign-out in that window
            // would file user A's pointer in user B's store, giving B a false
            // unclean-exit report and losing A's breadcrumb (shared clinic
            // tablets, rule 13).
            const activePointerWrite = scopeUnchanged()
              ? raceDurableActiveWrite(
                  durableActiveStore.setActive(existingDurable.recordingId, slotId, new Date().toISOString()),
                )
              : Promise.resolve();
            await withDurableOpWatchdog(
              recorder.resumeDurable({ userId: user.id, slotId, durable: existingDurable }),
              'resume',
            );
            await activePointerWrite;
            if (!scopeUnchanged()) {
              // Sign-out landed DURING the native resume. Finalize — never
              // discard: the manifest is how the departed user recovers this
              // audio (rule 8) — and release the singleton for the next user.
              await recorder.stop().catch(() => {});
              unbindRecorder();
              return;
            }
          } else {
            // Durable capture only for a FRESH recording (no durable/segments yet)
            // when the server-driven flag is on and the native module is available.
            // recorder.start(ctx) itself falls back to expo-audio on durable failure.
            const freshDurable =
              isDurableCaptureEnabled() &&
              durableRecorder.isAvailable() &&
              !!user?.id &&
              !!startSlot &&
              !startSlot.durable &&
              startSlot.segments.length === 0;
            if (freshDurable && user?.id) {
              // Storage Policy (plan): block a new durable recording below 250 MiB
              // free, warn below 500 MiB. Unknown free space fails open ('ok').
              const spaceGate = checkPreRecordFreeSpace();
              if (spaceGate === 'block') {
                unbindRecorder();
                trackEvent({ name: 'durable_low_space_stop', props: { free_bytes: getFreeDiskBytes() ?? undefined } });
                Alert.alert(
                  'Not Enough Storage',
                  'Your device is too low on free space to start a recording. Free up space (about 250 MB) and try again.',
                );
                return;
              }
              if (spaceGate === 'warn') {
                Alert.alert(
                  'Low Storage',
                  'Your device is low on free space. The recording may stop early if space runs out — free up space if you can.',
                );
              }
              // Same gate as the resume branch above: the native start itself
              // must not run for a departed user, and an in-flight start is
              // invisible to the unmount teardown.
              if (!scopeUnchanged()) {
                unbindRecorder();
                return;
              }
              const recordingId = newDurableRecordingId();
              startPath = 'durable_start';
              // Dispatch the active-pointer write (death-surviving breadcrumb)
              // and the native start together, joining the write after start
              // returns. Awaited first, its serial Keystore round trips gated
              // the mic on older devices. It is still bounded (raceDurableActiveWrite
              // resolves on timeout, so a hung Keystore can't strand the handler
              // before the watchdog/finally), still joined before the slot flips
              // to 'recording', and in practice still lands before the first ADTS
              // frame (encoder priming ≥250 ms). The contract was already
              // best-effort: on a skipped pointer crash recovery reconstructs the
              // recording from the native manifest.
              const activePointerWrite = scopeUnchanged()
                ? raceDurableActiveWrite(
                    durableActiveStore.setActive(recordingId, slotId, new Date().toISOString()),
                  )
                : Promise.resolve();
              freshDurableRecordingId = recordingId;
              await withDurableOpWatchdog(
                recorder.start({ userId: user.id, slotId, recordingId }),
                'start',
              );
              await activePointerWrite;
              if (!scopeUnchanged()) {
                // Sign-out landed DURING the native start — see the resume
                // branch. Finalize, never discard.
                freshDurableRecordingId = null;
                await recorder.stop().catch(() => {});
                unbindRecorder();
                return;
              }
              // start() SWALLOWS a durable failure and transparently continues on
              // expo-audio, so it resolves successfully and nothing above can tell
              // which backend actually won. If durable lost, the pointer we just
              // wrote is keyed by the durable recordingId and tagged 'durable',
              // while every expo cleanup path keys off slotId — so it would
              // survive a perfectly good recording and report a phantom kill.
              // Re-key it to match the backend that actually owns the capture.
              if (recorder.getSelectedBackend() === 'expo' && scopeUnchanged()) {
                freshDurableRecordingId = null;
                durableActiveStore.clearActive(recordingId).catch(() => {});
                expoPointerSlotId = slotId;
                // Named handle, joined below — the same post-start shape as
                // activePointerWrite/expoPointerWrite. The mic is already open
                // here, so this cannot gate start latency; the inline
                // await-the-call form is banned by the perf fences precisely
                // because before start it would.
                await racePreStartPointerWrite(
                  durableActiveStore.setActive(slotId, slotId, new Date().toISOString(), 'expo'),
                );
              }
            } else {
              // Expo fallback. It leaves no manifest and no recoverable file if
              // the process dies (MediaRecorder writes the MP4 moov atom only on
              // stop()), so this pointer is the ONLY evidence the capture ever
              // existed — which is what makes an OS kill visible at all.
              //
              // Dispatched alongside the native start and joined after it, for
              // the same reason as the durable branch above: awaiting serial
              // Keystore round trips here gated the mic on older tablets. The
              // slot cannot flip to 'recording' before the join, so a kill after
              // that point is always attributable.
              // Unlike the durable branch, this pointer is awaited BEFORE the
              // mic opens. Durable can afford to overlap because a manifest can
              // rebuild the recording either way; expo cannot — the pointer is
              // the only evidence the capture ever existed, and an .m4a killed
              // before stop() has no moov atom to recover. A kill in the gap
              // would lose the audio AND the ability to report it. Bounded at
              // 400 ms so a degraded Keystore delays the mic briefly instead of
              // stalling the tap.
              if (scopeUnchanged()) {
                expoPointerSlotId = slotId;
                await racePreStartPointerWrite(
                  durableActiveStore.setActive(slotId, slotId, new Date().toISOString(), 'expo'),
                );
              }
              await recorder.start();
            }
          }
          if (recordFirstEnabled) {
            const slot = sessionRef.current.slots.find((s) => s.id === slotId);
            if (slot && slot.segments.length === 0) {
              trackEvent({
                name: 'recording_started_blank_fields',
                props: { blank_field_count: countBlankRecordFirstFields(slot.formData) },
              });
            }
          }
          recordingSegmentStartedAtMsRef.current = Date.now();
          setAudioState(slotId, 'recording');
          // Tap→recording stopwatch: the number the owner actually feels. A
          // breadcrumb only — the native phases carry their own slow warnings.
          completePhaseFrom('record_tap_to_recording', tappedAtMs, { path: startPath }, { warningThresholdMs: null });
        } catch (error) {
          completePhaseFrom('record_tap_to_recording', tappedAtMs, { path: startPath }, { warningThresholdMs: null, outcome: 'error' });
          unbindRecorder();
          if (freshDurableRecordingId) {
            // Nothing owns this id (the hook discards a late-resolving native
            // start). durableActiveStore serializes its mutations, so this
            // clear runs AFTER the overlapped pointer write lands — never
            // racing it — and a start that captured no frame cannot read as
            // "previous process died mid-capture" on the next launch.
            durableActiveStore.clearActive(freshDurableRecordingId).catch(() => {});
          }
          if (expoPointerSlotId) {
            // A start that never captured a frame must not read as "the OS killed
            // us mid-capture" next launch. Denied mic permission, a busy mic and
            // native init failure all land here — the three most common start
            // failures — and each would otherwise tell the vet that Android
            // truncated a recording that never began. Serialized in the store, so
            // this clear lands after the overlapped write rather than racing it.
            durableActiveStore.clearActive(expoPointerSlotId).catch(() => {});
          }
          if (resumeDurableRecordingId) {
            durableActiveStore.clearActive(resumeDurableRecordingId).catch(() => {});
            setAudioState(slotId, 'stopped');
          }
          const errMsg = error instanceof Error ? error.message.toLowerCase() : '';
          const msg = resumeDurableRecordingId
            ? 'Could not continue this recording. You can submit it as-is or delete and start over.'
            : errMsg.includes('permission')
            ? 'Microphone permission is required. Please grant access in Settings.'
            : errMsg.includes('not ready')
              ? 'The recorder is still finishing a previous recording. Please try again in a moment.'
              : 'Could not start recording. Please check that your device has a microphone and it is not in use by another app.';
          Alert.alert('Recording Error', msg);
        } finally {
          startInFlightRef.current = false;
          setStartingSlotId((cur) => (cur === slotId ? null : cur));
        }
      })().catch(() => {
        startInFlightRef.current = false;
        setStartingSlotId((cur) => (cur === slotId ? null : cur));
      });
    },
    [recorder, bindRecorder, unbindRecorder, setAudioState, recordFirstEnabled, user?.id]
  );

  // Keep the ref in sync for the effect
  startRecordingRef.current = startRecordingForSlot;

  // Unmount teardown: a sign-out (or any teardown of the app group) while a
  // capture is live runs none of the Finish / discard / interruption paths, so
  // the pointer would survive. Durable pointer keys deliberately outlive
  // secureStorage.clearAll(), so it would sit there until the next launch and
  // report that Android stopped a recording the USER ended by logging out.
  //
  // Reads the live values from refs at teardown time. A real OS kill never runs
  // this cleanup, so genuine evidence is untouched.
  //
  // The user id is captured too, and cleared through clearActiveForUser: sign-out
  // rebinds durableActiveStore to null BEFORE clearing the React user state that
  // unmounts this screen, so anything relying on the ambient scope here would
  // capture null and silently do nothing.
  const liveCaptureRef = useRef<{
    userId: string | null;
    slotId: string | null;
    durableId: string | null;
  }>({ userId: null, slotId: null, durableId: null });
  liveCaptureRef.current = {
    userId: user?.id ?? null,
    slotId: session.recorderBoundToSlotId,
    durableId: recorder.activeDurableRecordingId,
  };
  useEffect(() => {
    return () => {
      const { userId, slotId, durableId } = liveCaptureRef.current;
      if (!userId) return;
      if (durableId) {
        // A live DURABLE capture must be FINALIZED before its breadcrumb goes.
        // The Android engine is a process singleton and detach() only flushes —
        // it deliberately leaves a running capture alive (DurableRecorderEngine
        // .detach) — so an unstopped one keeps the microphone open, keeps
        // appending under the DEPARTED user's directory, and makes the next
        // user's start throw BUSY (`running` guard in start()) on a shared
        // clinic tablet. expo-audio auto-releases on unmount; the durable
        // recorder has no such path, so this is it.
        void (async () => {
          try {
            await withPromiseTimeout(
              durableRecorder.stop({ userId, recordingId: durableId }),
              DURABLE_TEARDOWN_STOP_TIMEOUT_MS,
              'durable_teardown_stop',
            );
          } catch {
            // Could not finalize (broken, or the bridge never answered). KEEP
            // both pointers: one extra "recording interrupted" report is much
            // better than a microphone still running with nothing on disk
            // recording who owned it.
            return;
          }
          await durableActiveStore.clearActiveForUser(userId, durableId).catch(() => {});
          if (slotId) await durableActiveStore.clearActiveForUser(userId, slotId).catch(() => {});
        })();
        return;
      }
      if (slotId) durableActiveStore.clearActiveForUser(userId, slotId).catch(() => {});
    };
  }, []);

  const handlePause = useCallback(
    (slotId: string) => {
      (async () => {
        try {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
          await recorder.pause();
          setAudioState(slotId, 'paused');
        } catch {
          // pause() rethrows after internal cleanup (stops recorder, sets state to 'stopped').
          // The audio-capture effect will save the segment. Don't override audioState here.
          Alert.alert(
            'Recording Saved',
            'Could not pause — the recording segment was auto-saved. You can continue recording to add another segment.'
          );
        }
      })().catch(() => {});
    },
    [recorder, setAudioState]
  );

  const handleResume = useCallback(
    (slotId: string) => {
      (async () => {
        try {
          Haptics.selectionAsync().catch(() => {});
          await recorder.resume();
          recordingSegmentStartedAtMsRef.current ??= Date.now();
          setAudioState(slotId, 'recording');
        } catch {
          // resume() rethrows after internal cleanup (stops recorder, sets state to 'stopped').
          // The audio-capture effect will save the segment. Don't override audioState here.
          Alert.alert(
            'Recording Saved',
            'Could not resume — the recording segment was saved. Press "Continue Recording" to add a new segment.'
          );
        }
      })().catch(() => {});
    },
    [recorder, setAudioState]
  );

  const handleStop = useCallback(
    (slotId: string) => {
      (async () => {
        const targetSlotId = sessionRef.current.recorderBoundToSlotId ?? slotId;
        if (manualFinishSlotIdRef.current) return;
        manualFinishSlotIdRef.current = targetSlotId;
        setFinishingDraftSlotId(targetSlotId);
        // Captured before stop(): resetWithoutDelete() clears it, and the finally
        // below has to clear whichever key this capture was written under.
        const durableIdAtFinish = recorder.activeDurableRecordingId;

        try {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
          // The card is already in the "Saving…" state, so a hung native durable
          // stop would strand the user forever with no draft written. Bound the
          // durable stop with the same watchdog used for start (rejects → the
          // catch below shows the error Alert and the finally clears the state).
          // The expo path stop is already bounded internally, so wrap only durable.
          if (recorder.activeDurableRecordingId) {
            await withDurableOpWatchdog(recorder.stop(), 'stop');
          } else {
            await recorder.stop();
          }

          // Durable manual finish: audio is in audio.aac; attach the durable ref
          // and save a metadata-only draft (no segment files).
          if (recorder.activeDurableRecordingId) {
            const snap = recorder.getDurableSnapshot();
            const boundSlot = sessionRef.current.slots.find((s) => s.id === targetSlotId);
            if (!snap) {
              // Killed before the first complete frame — nothing recoverable.
              unbindRecorder();
              recordingSegmentStartedAtMsRef.current = null;
              if (boundSlot) {
                setAudioState(targetSlotId, boundSlot.segments.length > 0 ? 'stopped' : 'idle');
              }
              recorder.resetWithoutDelete();
              Alert.alert(
                'Recording Error',
                'The recording could not be captured. Any previously saved segments are still available.',
              );
              return;
            }
            const durableRef = {
              recordingId: snap.recordingId,
              codec: 'aac_lc' as const,
              sampleRate: snap.sampleRate,
              bitrate: snap.bitrate,
              durationMs: snap.durationMs,
              peakDb: snap.peakDb,
            };
            audioCaptureDoneRef.current = true;
            pendingDraftSlotIdRef.current = null;
            pendingDraftMinSegmentCountRef.current = 0;
            pendingDraftRecoveryReasonRef.current.set(targetSlotId, 'draft_finish');
            recordingSegmentStartedAtMsRef.current = null;
            setDurableRecording(targetSlotId, durableRef);
            durableActiveStore.clearActive(snap.recordingId).catch(() => {});
            recorder.resetWithoutDelete();
            if (boundSlot) {
              const durableSlot: PatientSlot = {
                ...boundSlot,
                durable: durableRef,
                segments: [],
                audioUri: null,
                audioDuration: snap.durationMs / 1000,
                audioState: 'stopped',
              };
              const savedDurable = await autoSaveDraftRef.current(durableSlot);
              if (!savedDurable) {
                Alert.alert(
                  'Recording Saved',
                  'The recording is available on this screen, but it could not be saved for restart recovery. Submit it or use Save for Later before leaving the app.',
                );
              }
            }
            return;
          }

          const snapshot = recorder.getPersistableSnapshot();
          if (!snapshot.audioUri) {
            const boundSlot = sessionRef.current.slots.find((s) => s.id === targetSlotId);
            unbindRecorder();
            recordingSegmentStartedAtMsRef.current = null;
            if (boundSlot) {
              setAudioState(targetSlotId, boundSlot.segments.length > 0 ? 'stopped' : 'idle');
            }
            recorder.reset();
            Alert.alert(
              'Recording Error',
              'The recording could not be captured. Any previously saved segments are still available.'
            );
            return;
          }

          const persistedSlot = buildPersistedSlot(targetSlotId, snapshot);
          if (!persistedSlot) {
            const orphanedSlot = sessionRef.current.slots.find((s) => s.id === targetSlotId);
            unbindRecorder();
            recordingSegmentStartedAtMsRef.current = null;
            if (orphanedSlot) {
              setAudioState(targetSlotId, orphanedSlot.segments.length > 0 ? 'stopped' : 'idle');
            }
            recorder.resetWithoutDelete();
            Alert.alert(
              'Recording Error',
              'The recording could not be linked to this patient. Please try recording again.'
            );
            return;
          }

          audioCaptureDoneRef.current = true;
          pendingDraftSlotIdRef.current = null;
          pendingDraftMinSegmentCountRef.current = 0;
          pendingDraftRecoveryReasonRef.current.set(targetSlotId, 'draft_finish');
          recordingSegmentStartedAtMsRef.current = null;
          saveAudio(
            targetSlotId,
            snapshot.audioUri,
            snapshot.duration,
            snapshot.maxMetering
          );
          recorder.resetWithoutDelete();

          // Capture is over the moment the snapshot is in the slot, so the
          // pointer is cleared HERE, not only in the finally below.
          // autoSaveDraft copies the audio, writes chunked SecureStore metadata
          // and creates a server draft — seconds on a loaded SM-T220 — and a
          // process death inside that window would leave a pointer for a
          // recording that ended cleanly, reporting a phantom interruption on
          // the next launch and nagging the vet about battery settings for a
          // recording that saved perfectly. Awaited so it lands before the slow
          // work begins; bounded by the store's own 5s mutation timeout, so a
          // degraded Keystore cannot stall Finish. The finally still repeats
          // both clears — it covers the early returns and the catch, and a
          // second clear is a no-op.
          await durableActiveStore.clearActive(targetSlotId).catch(() => {});
          if (durableIdAtFinish) {
            await durableActiveStore.clearActive(durableIdAtFinish).catch(() => {});
          }

          const saved = await autoSaveDraftRef.current(persistedSlot);
          if (!saved) {
            Alert.alert(
              'Recording Saved',
              'The recording is available on this screen, but it could not be saved for restart recovery. Submit it or use Save for Later before leaving the app.'
            );
          }
        } catch {
          Alert.alert('Recording Error', 'Failed to stop recording.');
        } finally {
          // Manual Finish is how a recording NORMALLY ends, and it sets
          // manualFinishSlotIdRef, which makes the stopped-state effect return
          // before its own pointer cleanup. Without this every ordinary finish
          // left a live pointer, so the next launch would tell essentially every
          // user that Android truncated audio that saved perfectly — the detector
          // would have been pure noise. Cleared in `finally` so the success path,
          // both "could not be captured/linked" early returns and the catch are
          // all covered. Both keys: expo captures are keyed by slot, durable by
          // recording id.
          durableActiveStore.clearActive(targetSlotId).catch(() => {});
          if (durableIdAtFinish) {
            durableActiveStore.clearActive(durableIdAtFinish).catch(() => {});
          }
          manualFinishSlotIdRef.current = null;
          setFinishingDraftSlotId((current) => current === targetSlotId ? null : current);
        }
      })().catch(() => {});
    },
    [buildPersistedSlot, recorder, saveAudio, setAudioState, unbindRecorder, setDurableRecording]
  );

  const handleContinueRecording = useCallback(
    (slotId: string) => {
      const slot = session.slots.find((s) => s.id === slotId);
      if (isSlotUploadActive(slotId)) {
        showUploadInProgressAlert();
        return;
      }
      if (slot?.pendingConfirm) {
        Alert.alert(
          'Finish Submission First',
          'This recording has already reached secure storage. Retry Submit or delete it and start over before adding more audio.',
        );
        return;
      }
      if (slot?.durable && (slot.uploadStatus === 'success' || slot.durable.recoveredAudioUri)) {
        Alert.alert(
          'Recording Complete',
          'This recording can be submitted as-is or deleted and started over.',
        );
        return;
      }
      const continueAfterIdentityReady = (freshAudioUploadKey?: string) => {
        const beginContinue = () => {
          if (!session.recorderBoundToSlotId || session.recorderBoundToSlotId === slotId) {
            recorder.resetWithoutDelete();
          }
          continueRecording(slotId, freshAudioUploadKey);
          if (slot?.durable) startRecordingForSlot(slotId);
        };
        if (
          slot?.durable &&
          session.recorderBoundToSlotId &&
          session.recorderBoundToSlotId !== slotId
        ) {
          const boundSlot = session.slots.find((s) => s.id === session.recorderBoundToSlotId);
          if (boundSlot && recorder.state === 'recording') {
            Alert.alert(
              'Stop Current Recording?',
              `Stop recording for ${boundSlot.formData.patientName || 'the other patient'} before continuing this one?`,
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Stop & Continue',
                  onPress: () => {
                    continueRecording(slotId, freshAudioUploadKey);
                    enqueuePendingStart(slotId);
                    (async () => {
                      try {
                        await recorder.stop();
                      } catch {
                        removePendingStart(slotId);
                        setAudioState(slotId, 'stopped');
                        Alert.alert('Recording Error', 'Failed to stop the current recording.');
                      }
                    })().catch(() => {});
                  },
                },
              ]
            );
            return;
          }
          if (boundSlot && recorder.state === 'paused') {
            continueRecording(slotId, freshAudioUploadKey);
            enqueuePendingStart(slotId);
            (async () => {
              try {
                await recorder.stop();
              } catch {
                removePendingStart(slotId);
                setAudioState(slotId, 'stopped');
                Alert.alert('Recording Error', 'Failed to stop the current recording.');
              }
            })().catch(() => {});
            return;
          }
        }
        beginContinue();
      };

      if (
        slot?.durable &&
        slot.uploadKeyOverride &&
        isAudioChangeUploadIdempotencyKey(slot.uploadKeyOverride) &&
        !slot.supersededUploadKey &&
        slot.uploadStatus === 'pending' &&
        !slot.serverRecordingId &&
        !slot.pendingConfirm &&
        !slot.uploadRecovery
      ) {
        continueAfterIdentityReady(slot.uploadKeyOverride);
        return;
      }

      if (
        slot?.durable &&
        (
          slot.uploadKeyOverride ||
          slot.supersededUploadKey ||
          slot.uploadRecovery ||
          slot.pendingConfirm ||
          slot.serverRecordingId ||
          slot.uploadStatus === 'error'
        )
      ) {
        const initiatingScopeKey = authScopeKeyRef.current;
        const initiatingScopeGeneration = authScopeGenerationRef.current;
        const initiatingUserId = user?.id;
        const scopeIsCurrent = () =>
          authScopeMountedRef.current &&
          initiatingScopeKey !== null &&
          initiatingUserId !== undefined &&
          authScopeKeyRef.current === initiatingScopeKey &&
          authScopeGenerationRef.current === initiatingScopeGeneration &&
          draftStorage.getUserId() === initiatingUserId;
        rotateDurableAudioIdentityRef.current(slot)
          .then((freshAudioUploadKey) => {
            if (!scopeIsCurrent()) return;
            if (!freshAudioUploadKey) {
              Alert.alert(
                'Continue Not Started',
                'Captivet could not safely rotate this recording to a fresh upload identity. The saved audio is unchanged.',
              );
              return;
            }
            continueAfterIdentityReady(freshAudioUploadKey);
          })
          .catch(() => {
            if (!scopeIsCurrent()) return;
            Alert.alert(
              'Continue Not Started',
              'Captivet could not safely rotate this recording to a fresh upload identity. The saved audio is unchanged.',
            );
          });
        return;
      }

      continueAfterIdentityReady();
    },
    [isSlotUploadActive, session.recorderBoundToSlotId, session.slots, continueRecording, recorder, startRecordingForSlot, enqueuePendingStart, removePendingStart, setAudioState, user?.id]
  );

  const handleRecordAgain = useCallback(
    (slotId: string) => {
      const slot = session.slots.find((s) => s.id === slotId);
      if (isSlotUploadActive(slotId)) {
        showUploadInProgressAlert();
        return;
      }
      const segmentCount = slot?.segments.length ?? 0;
      Alert.alert(
        segmentCount > 1 ? 'Delete All Recordings?' : 'Delete Current Recording?',
        segmentCount > 1
          ? `All ${segmentCount} recording segments will be permanently deleted and cannot be recovered. Are you sure you want to start over?`
          : 'Your current recording will be permanently deleted and cannot be recovered. Are you sure you want to start over?',
        [
          { text: 'Keep Recording', style: 'cancel' },
          {
            text: 'Delete & Start Over',
            style: 'destructive',
            onPress: () => {
              if (slot) {
                slot.segments.forEach((seg) => {
                  // draftStorage owns draft-directory files; deleteSlotDraft
                  // below is the authoritative deleter for those.
                  if (!isDraftOwnedUri(seg.uri)) {
                    safeDeleteFile(seg.uri);
                  }
                });
                // Explicit user discard of a durable recording -> discard the
                // durable audio.aac so recovery never re-offers it. A vault-restored
                // durable slot's audio is a loose recoveredAudioUri (no native
                // manifest for discard() to remove), so delete that copy too.
                if (slot.durable) {
                  if (user?.id) {
                    durableRecorder
                      .discard({ userId: user.id, recordingId: slot.durable.recordingId })
                      .catch(() => {});
                  }
                  durableActiveStore.clearActive(slot.durable.recordingId).catch(() => {});
                  if (slot.durable.recoveredAudioUri) safeDeleteFile(slot.durable.recoveredAudioUri);
                }
                deleteOrphanServerRecording(slot);
                // Drop any auto-saved draft + server draft row — otherwise the
                // slot gets a fresh recording but the old "Not Submitted" card
                // + its PHI on disk linger until cleanupOrphaned sweeps them.
                deleteSlotDraft(slot);
              }
              clearAudio(slotId);
              // Only reset recorder if it's not actively recording another patient
              if (!session.recorderBoundToSlotId || session.recorderBoundToSlotId === slotId) {
                recorder.reset();
              }
            },
          },
        ]
      );
    },
    [isSlotUploadActive, session.slots, session.recorderBoundToSlotId, clearAudio, recorder, deleteOrphanServerRecording, deleteSlotDraft, user?.id]
  );

  const handleRemove = useCallback(
    (slotId: string) => {
      const slot = session.slots.find((s) => s.id === slotId);
      if (!slot) return;
      if (isSlotUploadActive(slotId)) {
        showUploadInProgressAlert();
        return;
      }
      // Removing the patient discards the durable manifest or local draft AND
      // the card with it, while uploadStatus 'success' keeps the possibly-wrong
      // server recording — the persistent hold then protects nothing and can
      // never be released. Resolve the conflict first, exactly as stashing and
      // Submit All now require.
      if (slot.metadataDivergence?.tier === 'identity') {
        Alert.alert(
          METADATA_DIVERGENCE_COPY.removeBlockedTitle,
          METADATA_DIVERGENCE_COPY.removeBlockedBody
        );
        return;
      }

      const hasRecording = slotHasRecoverableAudio(slot) || isSlotActivelyRecording(slot);

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});

      if (hasRecording) {
        Alert.alert(
          'Remove Patient?',
          `This will permanently delete the recording for ${slot.formData.patientName || 'this patient'}. This cannot be undone.`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Remove',
              style: 'destructive',
              onPress: () => {
                (async () => {
                  try {
                    // Stop recording if this slot owns the recorder
                    if (session.recorderBoundToSlotId === slotId) {
                      skipNextAudioCaptureRef.current = true;
                      // Same reason as discardCurrentSession: captured before
                      // stop/unbind/reset erase the lookup state the passive
                      // stopped-state effect would have needed.
                      const removedDurableId = recorder.activeDurableRecordingId;
                      try { await recorder.stop(); } catch {}
                      durableActiveStore.clearActive(slotId).catch(() => {});
                      if (removedDurableId) {
                        durableActiveStore.clearActive(removedDurableId).catch(() => {});
                      }
                      unbindRecorder();
                      recorder.reset();
                    }
                    slot.segments.forEach((seg) => {
                      // draftStorage owns draft-directory files; deleteSlotDraft
                      // below is the authoritative deleter for those.
                      if (!isDraftOwnedUri(seg.uri)) {
                        safeDeleteFile(seg.uri);
                      }
                    });
                    if (slot.durable) {
                      if (user?.id) {
                        durableRecorder
                          .discard({ userId: user.id, recordingId: slot.durable.recordingId })
                          .catch(() => {});
                      }
                      durableActiveStore.clearActive(slot.durable.recordingId).catch(() => {});
                      // Vault-restored durable audio is a loose recoveredAudioUri
                      // (no native manifest) — delete it too, else Remove leaves it.
                      if (slot.durable.recoveredAudioUri) safeDeleteFile(slot.durable.recoveredAudioUri);
                    }
                    deleteOrphanServerRecording(slot, 'remove_slot');
                    // Slot is about to disappear — delete its draft row + local
                    // audio so it doesn't surface as "Not Submitted" on Home.
                    deleteSlotDraft(slot, 'remove_slot');
                    removeSlot(slotId);
                  } catch {}
                })().catch(() => {});
              },
            },
          ]
        );
      } else {
        deleteOrphanServerRecording(slot, 'remove_slot');
        deleteSlotDraft(slot, 'remove_slot');
        removeSlot(slotId);
      }
    },
    [isSlotUploadActive, session.slots, session.recorderBoundToSlotId, recorder, removeSlot, unbindRecorder, deleteOrphanServerRecording, deleteSlotDraft, user?.id]
  );

  const slotHasLiveRecorder = useCallback(
    (slot: PatientSlot) =>
      isSlotActivelyRecording(slot) ||
      (session.recorderBoundToSlotId === slot.id &&
        (recorder.state === 'recording' || recorder.state === 'paused')),
    [session.recorderBoundToSlotId, recorder.state]
  );

  // -- Upload handlers --

  /**
   * Write a reconciliation hold for a SPECIFIC user.
   *
   * `durableReconcileHold` keys off its own mutable current user, which the
   * AuthProvider re-points on every sign-in. An upload that completes across a
   * rapid sign-out/sign-in would otherwise write the departing user's recording
   * id into the ARRIVING user's list and then mark the departing user's
   * manifest uploaded — so the original owner comes back to a confirmed
   * manifest with no hold (startup self-heal purges the retained copy) while
   * the new user inherits a hold for a recording that is not theirs.
   *
   * Verified on both sides of the await, and a mismatch afterwards tries to
   * take the stray entry back out of whichever list is now scoped. Returns
   * false unless the hold is known to have landed in the right one — the
   * callers treat that as "do not terminalize the manifest".
   */
  const addReconcileHoldForUser = useCallback(
    async (userId: string, recordingId: string): Promise<boolean> => {
      if (durableReconcileHold.getUserId() !== userId) return false;
      const persisted = await durableReconcileHold.add(recordingId).catch(() => false);
      if (durableReconcileHold.getUserId() !== userId) {
        // The scope moved under the write. If the entry landed in the list that
        // is scoped now, this removes it; if it landed correctly in the old
        // user's list, this is a no-op against a list that never had it.
        await durableReconcileHold.remove(recordingId).catch(() => {});
        return false;
      }
      return persisted;
    },
    []
  );

  /**
   * Release a reconciliation hold and REPORT whether it actually landed.
   *
   * `remove()` signals a failed read-or-rewrite by resolving false, and every
   * release site below runs after the draft and audio it protected are already
   * deleted — so there is no object and no card action left that could retry
   * it. Swallowing the result stranded one entry per failure, permanently, and
   * `add()` refuses past MAX_RECONCILE_HOLDS rather than evicting, so enough of
   * them quietly remove the ability to protect the NEXT conflict at all.
   *
   * The store now queues a failed release and applies it on the next successful
   * mutation for the user (which includes the `add()` that would otherwise hit
   * the cap). This is the observability half: the reconciliation itself has
   * genuinely succeeded, so it must not be failed back to the vet, but a store
   * that keeps refusing writes should be visible rather than silent.
   */
  const releaseReconcileHold = useCallback(
    async (holdId: string | null | undefined, context: string): Promise<boolean> => {
      if (!holdId) return true;
      const released = await durableReconcileHold.remove(holdId).catch(() => false);
      if (!released) {
        breadcrumb('upload', 'reconcile_hold_release_deferred', { context });
      }
      return released;
    },
    []
  );

  const uploadSlot = useCallback(
    async (slotArg: PatientSlot): Promise<string | null> => {
      // Re-read the latest slot from state. A stale closure (e.g. held by a
      // memoized child or an async caller) can pass in a slot object from
      // before the most recent `SET_DRAFT_IDS` dispatch — reading fresh here
      // guarantees we see `serverDraftId` / `draftMetadataDirty` / etc.
      const latestSlot = sessionRef.current.slots.find((s) => s.id === slotArg.id);
      const slot =
        slotArg.supersededUploadKey &&
        latestSlot?.uploadKeyOverride !== slotArg.uploadKeyOverride
          ? slotArg
          : (latestSlot ?? slotArg);
      if (!canRecordAppointments(user?.role)) {
        showRecordPermissionAlert();
        return null;
      }
      if ((slot.segments.length === 0 && !slot.durable && !slot.pendingConfirm) || slot.uploadStatus === 'uploading') return null;
      if (slot.uploadStatus === 'success') return slot.serverRecordingId ?? null;
      // Synchronous ref guard — prevents a second concurrent upload of the same slot
      // during the window between button tap and React state update disabling the button.
      if (uploadingSlotIdsRef.current.has(slot.id)) return null;
      uploadingSlotIdsRef.current.add(slot.id);
      // Fresh attempt — clear any stale auto-stash flag from a prior failure
      // so retry-then-succeed doesn't accidentally stash on the next failure
      // path that wasn't actually network-dead.
      autoStashableFailuresRef.current.delete(slot.id);
      // Hold a wake-lock for the duration of this slot's upload. Per Sentry
      // 7445949187, Android Doze + ConnectivityManager reap the R2 PUT's TCP
      // socket the moment the screen sleeps mid-upload, surfacing as
      // `Failed to connect`. Tag is per-slot so concurrent uploads don't fight
      // over a shared lock; expo-keep-awake aggregates across tags. Released
      // unconditionally in the finally below.
      const keepAwakeTag = `captivet-upload-${slot.id}`;
      const keepAwakeLease = acquireKeepAwakeLease(
        keepAwakeTag,
        activateKeepAwakeAsync,
        deactivateKeepAwake,
      );

      // Attempt-owned scratch is declared before the outer try so its finally
      // also covers a later synchronous analytics/state helper throw.
      let segmentsForUpload = slot.segments;
      let splitTempDir: string | null = null;
      let splitTempUris: string[] = [];
      let uploadSizeBytes = 0;
      let localAudioAvailableForRestart = false;
      let durableSnapshotUri: string | null = null;

      try {
      const attemptNumber = (uploadAttemptCountsRef.current.get(slot.id) ?? 0) + 1;
      uploadAttemptCountsRef.current.set(slot.id, attemptNumber);
      const currentSlots = sessionRef.current.slots;
      const slotIndex = currentSlots.findIndex((s) => s.id === slot.id);
      const slotCount = currentSlots.length;
      // Durable AAC is one upload file backed by a native manifest, so its
      // segments[] is intentionally empty. Report the upload shape instead of
      // emitting the misleading 0 files / 0 seconds seen in NODE-19.
      const durationSeconds = Math.round(
        slot.durable
          ? slot.durable.durationMs / 1000
          : slot.segments.reduce((sum, seg) => sum + (seg.duration ?? 0), 0)
      );
      const segmentCount = slot.durable ? 1 : slot.segments.length;
      const uploadStartedAt = Date.now();
      const netState = networkStateForTelemetry();
      // The server's copy of the metadata can differ from the snapshot we sent
      // without that being a failed submit. Identity-tier divergence is the one
      // case that must hold the local copy back from cleanup until a human
      // settles which visit the server row belongs to.
      let metadataDivergence: MetadataDivergenceReport | null = null;
      // A new attempt re-derives the answer, so a card from the previous one
      // must not linger over it.
      if (slot.metadataDivergence) {
        dispatch({ type: 'SET_METADATA_DIVERGENCE', slotId: slot.id, divergence: null });
      }
      const onMetadataDivergence = (report: MetadataDivergenceReport) => {
        metadataDivergence = report;
        // A divergence that no longer fails the submit must still be visible,
        // or the fix would just convert loud false failures into silence.
        reportClientError({
          phase: 'patch_draft',
          severity: report.tier === 'identity' ? 'error' : 'warning',
          errorCode: METADATA_MISMATCH_ERROR_CODE,
          message: `Recording metadata diverged after upload. tier=${report.tier} fields=${[...report.fields].sort().join(',')}`,
          recordingId: slot.serverDraftId ?? slot.serverRecordingId ?? undefined,
          slotIndex,
          networkState: networkStateForTelemetry(),
          attemptNumber,
        });
        dispatch({
          type: 'SET_METADATA_DIVERGENCE',
          slotId: slot.id,
          divergence: {
            tier: report.tier,
            fields: [...report.fields],
            recordingId: slot.serverDraftId ?? slot.serverRecordingId ?? '',
          },
        });
      };
      const willUseAtomicMetadataUpdate = !!slot.serverDraftId && slot.draftMetadataDirty;
      const baseSubmitDiagnostics = slotSubmitDiagnostics(slot, slotCount, {
        confirmUsedAtomicMetadataUpdate: willUseAtomicMetadataUpdate,
      });

      trackEvent({
        name: 'submit_attempted',
        props: {
          slot_index: slotIndex,
          segment_count: segmentCount,
          duration_s: durationSeconds,
          recording_id: slot.serverDraftId ?? slot.serverRecordingId ?? undefined,
          attempt_number: attemptNumber,
          network_state: netState,
          ...baseSubmitDiagnostics,
        },
      });
      breadcrumb('upload', 'submit_attempted', {
        slot_index: slotIndex,
        segment_count: segmentCount,
        duration_s: durationSeconds,
        attempt_number: attemptNumber,
        network_state: netState,
        has_existing_draft: !!slot.serverDraftId,
        has_pending_confirm: !!slot.pendingConfirm,
        draft_metadata_dirty: !!slot.draftMetadataDirty,
        confirm_used_atomic_metadata_update: willUseAtomicMetadataUpdate,
      });

      try {
        // Prefer the file-backed recovery engine while a complete local copy is
        // still available. It confirms first, but can perform the single allowed
        // prepare + PUT restart if the hinted server row was deleted. Reserve
        // confirmation-only recovery for the case where R2 is the sole copy.
        if (slot.pendingConfirm) {
          const uid = user?.id;
          const durable = slot.durable;
          if (durable && !uid) {
            showRecordPermissionAlert();
            return null;
          }
          let nativeManifest: Awaited<
            ReturnType<typeof durableRecorder.getManifest>
          > = null;
          let hasCompleteLocalAudio = false;
          if (durable && uid) {
            const availability = await probePendingDurableAvailability({
              getManifest: () =>
                durableRecorder.getManifest({
                  userId: uid,
                  recordingId: durable.recordingId,
                }),
              sourceUriFromManifest: (value) =>
                value?.audioFile.uri ?? null,
              fallbackSourceUri: durable.recoveredAudioUri ?? null,
              getMetadata: getInfoAsync,
            });
            nativeManifest = availability.manifest;
            hasCompleteLocalAudio = availability.hasCompleteLocalAudio;
          } else if (slot.segments.length > 0) {
            hasCompleteLocalAudio = await probePendingStandardAvailability(
              slot.segments.map((segment) => segment.uri),
              getInfoAsync,
            );
          }
          localAudioAvailableForRestart = hasCompleteLocalAudio;

          if (!hasCompleteLocalAudio) {
            const onClearPendingConfirm = async () => {
              dispatch({ type: 'SET_PENDING_CONFIRM', slotId: slot.id, pendingConfirm: null });
              await draftStorage.updatePendingConfirm(slot.draftSlotId ?? slot.id, null);
              if (durable && uid && nativeManifest) {
                await durableRecorder.setPendingConfirm({
                  userId: uid,
                  recordingId: durable.recordingId,
                  pendingConfirm: null,
                });
              }
            };
            setUploadStatus(slot.id, 'uploading', { progress: 95 });
            const result = await recordingsApi.confirmPendingUpload(
              slot.formData,
              slot.pendingConfirm,
              {
                idempotencyKey: uploadKeyForSlot(slot),
                ...(slot.supersededUploadKey
                  ? { supersededIdempotencyKey: slot.supersededUploadKey }
                  : {}),
                pimsPatientIdExplicitlyCleared: isPimsPatientIdExplicitlyCleared(
                  slot.formData.pimsPatientId,
                  slot.pimsPatientIdExplicitlyCleared,
                ),
                onMetadataDivergence,
                onClearPendingConfirm,
                mode: durable ? 'durable' : 'standard',
                slotIndex,
              },
            );

            completedUploadSlotIdsRef.current.add(slot.id);
            setUploadStatus(slot.id, 'success', { progress: 100, serverRecordingId: result.id });
            recordSubmitAttempt(result.id);

            // Same hold-back as the standard success path below. Durable
            // captures are exactly the recordings the durability work exists to
            // protect, so an identity divergence must not purge the native
            // manifest, the recovered audio, or the draft that anchors them.
            //
            // ...but only when there is something to hold. This branch also
            // covers confirmation-only recovery, where the local audio is
            // already gone; holding then promises a device copy that does not
            // exist, blocks navigation on it, and offers "submit separately"
            // that can only fail preflight. With no bytes left the conflict is
            // server-only, so it is re-tiered to the non-destructive card.
            const divergenceReport = metadataDivergence as MetadataDivergenceReport | null;
            const holdDurableLocalCopy =
              divergenceReport?.tier === 'identity' && localAudioAvailableForRestart;
            // PERSIST the hold BEFORE markUploaded. The divergence lives in
            // React state and dies with the process, while markUploaded() is
            // permanent AND is what makes the manifest eligible for startup
            // self-heal — so writing the hold afterwards leaves a crash window,
            // and ignoring a failed write leaves a confirmed manifest with no
            // hold at all. Either way the next scan purges the copy the card
            // promised to keep.
            const holdPersisted =
              holdDurableLocalCopy && durable && uid
                ? await addReconcileHoldForUser(uid, durable.recordingId)
                : false;
            if (holdDurableLocalCopy && !holdPersisted) {
              captureMessage('durable_identity_hold_not_persisted', 'warning', {
                tags: { phase: 'upload_recovery', mode: 'durable' },
              });
            }
            if (divergenceReport?.tier === 'identity' && !localAudioAvailableForRestart) {
              dispatch({
                type: 'SET_METADATA_DIVERGENCE',
                slotId: slot.id,
                divergence: {
                  tier: 'unknown',
                  fields: [...divergenceReport.fields],
                  recordingId: result.id,
                },
              });
            }

            if (durable && uid) {
              const confirmedAt = new Date().toISOString();
              // Mark the manifest uploaded — the record that stops durable
              // recovery re-offering an already-uploaded capture; skipping it
              // would trade a false failure for a duplicate server recording.
              // The ONE exception is an identity hold we could not persist: an
              // un-marked manifest is re-OFFERED (recoverable, and the
              // deterministic durable key makes a re-submit promote the same
              // row), while a marked one with no hold is PURGED.
              if (nativeManifest && (!holdDurableLocalCopy || holdPersisted)) {
                await durableRecorder
                  .markUploaded({ userId: uid, recordingId: durable.recordingId, confirmedUploadAt: confirmedAt })
                  .catch(() => {});
              }
              // Same key rule as the release transaction: the draft is owned
              // by draftSlotId, which is NOT slot.id for a slot resumed from a
              // stash. Addressing slot.id deletes nothing and then PROVES that
              // never-written key missing, so the purge below runs against a
              // draft that still exists and still points at the audio.
              const ownedDraftSlotId = slot.draftSlotId ?? slot.id;
              const confirmDraftGone = async (): Promise<boolean> => {
                try {
                  await draftStorage.deleteDraft(ownedDraftSlotId);
                  await recoveryIntent.clearForDraftSlot(ownedDraftSlotId);
                } catch {
                  return false;
                }
                // getDraft is LENIENT: an unreadable Keystore also yields null,
                // which would read as proof of deletion and license the purge
                // below. Only PROVEN absence counts.
                return (
                  (await draftStorage
                    .draftMetadataExistsStrict(ownedDraftSlotId)
                    .catch(() => 'unknown' as const)) === 'missing'
                );
              };
              // Only the destructive half is held back.
              if (!holdDurableLocalCopy) {
                let draftDeleted = await confirmDraftGone();
                if (!draftDeleted) draftDeleted = await confirmDraftGone();
                if (draftDeleted) {
                  if (nativeManifest) {
                    await durableRecorder.purgeAfterUpload({ userId: uid, recordingId: durable.recordingId }).catch(() => {});
                  } else if (durable.recoveredAudioUri) {
                    safeDeleteFile(durable.recoveredAudioUri);
                  }
                }
                await durableTombstone.add(durable.recordingId).catch(() => {});
                durableRecoveryStore.remove(durable.recordingId);
              }
              trackEvent({ name: 'durable_upload_confirmed', props: { recording_id: result.id } });
            } else if (!holdDurableLocalCopy) {
              slot.segments.forEach((segment) => safeDeleteFile(segment.uri));
              draftStorage.deleteDraft(slot.id).catch(() => {});
              recoveryIntent.clearForDraftSlot(slot.id).catch(() => {});
            }

            const latencyMs = Date.now() - uploadStartedAt;
            trackEvent({
              name: 'submit_succeeded',
              props: {
                slot_index: slotIndex,
                segment_count: segmentCount,
                duration_s: durationSeconds,
                size_bytes: 0,
                recording_id: result.id,
                attempt_number: attemptNumber,
                latency_ms: latencyMs,
                ...baseSubmitDiagnostics,
              },
            });
            breadcrumb('upload', 'pending_confirm_recovered', {
              slot_index: slotIndex,
              attempt_number: attemptNumber,
              latency_ms: latencyMs,
            });
            uploadAttemptCountsRef.current.delete(slot.id);
            return result.id;
          }
        }

        // ── Durable AAC upload (single audio.aac, no segments[], bypass split) ──
        if (slot.durable) {
          const durable = slot.durable;
          const uid = user?.id;
          if (!uid) {
            showRecordPermissionAlert();
            return null;
          }
          const durableMetadata = await readDurableUploadMetadata({
            getManifest: () =>
              durableRecorder.getManifest({
                userId: uid,
                recordingId: durable.recordingId,
              }),
            sourceUriFromManifest: (value) =>
              value?.audioFile.uri ?? null,
            fallbackSourceUri: durable.recoveredAudioUri ?? null,
            getMetadata: getInfoAsync,
          });
          const manifest = durableMetadata.manifest;
          // A support-staff cross-user vault restore has no native manifest under
          // THIS user's scope, but the vault preserved a local audio.aac copy
          // (durable.recoveredAudioUri) that we upload directly. Native-manifest
          // ops (anchor/markUploaded/purge) are skipped for that path.
          const hasNativeManifest = !!manifest;
          const durableUri = durableMetadata.sourceUri;
          if (!durableUri) {
            // No native manifest and no recovered copy — needs an app update.
            setUploadStatus(slot.id, 'error', {
              error: 'This recording needs an app update to submit. Please update Captivet.',
            });
            trackEvent({ name: 'durable_recorder_unavailable', props: { reason: 'upload_no_manifest' } });
            return null;
          }
          const durableDurationSeconds = Math.round(durable.durationMs / 1000);

          // Recovered oversized source (older build/bug): block normal submit,
          // keep local file, show contact-support message (do NOT purge).
          const info = durableMetadata.sourceInfo;
          const durableSizeBytes = info?.exists ? info.size ?? 0 : 0;
          if (!info?.exists || durableSizeBytes === 0) {
            setUploadStatus(slot.id, 'error', { error: 'The recording audio was not found on this device.' });
            return null;
          }
          localAudioAvailableForRestart = true;
          if (durableSizeBytes > 250 * 1024 * 1024) {
            trackEvent({ name: 'durable_aac_oversize_recovered', props: { size_bytes: durableSizeBytes } });
            setUploadStatus(slot.id, 'error', {
              error: 'This recording is too large to submit automatically. Please contact support to recover it.',
            });
            return null;
          }

          // Silent-audio guard from the synthetic durable peak (fails closed).
          const durableSilence = await checkSilentAudio(slot);
          if (durableSilence.silent) {
            const override = await confirmSilentUpload({ durable: true });
            if (!override) {
              const silentErr = new Error(
                'This recording appears silent. Please verify microphone input and record again before uploading.',
              ) as Error & { uploadPhase?: 'silent_check' };
              silentErr.uploadPhase = 'silent_check';
              throw silentErr;
            }
          }

          // Upload an immutable snapshot of ONLY the complete-ADTS-frame prefix.
          // A crash can leave a torn partial frame past completeFrameBytes, and a
          // recorder race can append bytes after createWithFile reads the source
          // size. Uploading the live audio.aac in either case makes the presigned
          // Content-Length disagree with the bytes the native uploader reads
          // (Sentry REACT-NATIVE-4: "expected N bytes but received M"). Always
          // copying the anchored prefix makes the preflight size and upload body
          // refer to the same frozen file. A recovered vault copy is already a
          // static, prefix-truncated file and therefore does not need this copy.
          let durableUploadUri = durableUri;
          const completeFrameBytes = manifest?.audioFile.completeFrameBytes ?? 0;
          if (hasNativeManifest) {
            if (completeFrameBytes <= 0 || completeFrameBytes > durableSizeBytes) {
              const anchorError = new Error(
                'The recording audio is still being finalized. Please wait a moment and try submitting again.',
              ) as Error & { uploadPhase?: 'preflight' };
              anchorError.uploadPhase = 'preflight';
              throw anchorError;
            }
            const tempUri = createDurableUploadSnapshotUri(Paths.cache.uri);
            if (writeFilePrefix(durableUri, tempUri, completeFrameBytes)) {
              // Assign ownership immediately after creation succeeds. The
              // upload-attempt finally owns this unique pathname from here on.
              durableSnapshotUri = tempUri;
              durableUploadUri = tempUri;
              breadcrumb('upload', 'durable_snapshot_created', {
                file_bytes: durableSizeBytes,
                prefix_bytes: completeFrameBytes,
              });
            } else {
              safeDeleteFile(tempUri);
              const snapshotError = new Error(
                'The recording could not be prepared for upload. Your audio is still saved; please try again.',
              ) as Error & { uploadPhase?: 'preflight' };
              snapshotError.uploadPhase = 'preflight';
              throw snapshotError;
            }
          }

          setUploadStatus(slot.id, 'uploading', { progress: 5 });
          let lastDurableProgress = 0;
          // Promote-in-place: reuse the death-surviving server draft. Dirty
          // metadata is sent with confirm-upload so metadata + status commit
          // atomically; if the server cannot apply it, uploadSlot fails closed.
          let durableUseExisting = slot.serverDraftId ?? slot.serverRecordingId ?? undefined;
          let durableResult;
          durableResult = await recordingsApi.createWithFile(
              slot.formData,
              durableUploadUri,
              'audio/aac',
              {
                fileName: 'recording.aac',
                // Deterministic key derived from the on-disk durable recordingId so
                // a retried create() after a kill reuses the same server row.
                idempotencyKey: uploadKeyForSlot(slot),
                ...(slot.supersededUploadKey
                  ? { supersededIdempotencyKey: slot.supersededUploadKey }
                  : {}),
                // Persist serverRecordingId into the manifest BEFORE the R2 PUT.
                // No-op for a recovered vault copy (no native manifest to anchor).
                onRecordingPrepared: async (recordingId) => {
                  dispatch({
                    type: 'SET_DRAFT_IDS',
                    slotId: slot.id,
                    draftSlotId: slot.draftSlotId ?? slot.id,
                    serverDraftId: recordingId,
                  });
                  const anchorResult = await draftStorage.updateServerDraftId(
                    slot.draftSlotId ?? slot.id,
                    recordingId,
                    uploadKeyForSlot(slot),
                  );
                  if (anchorResult === 'no_local_meta') {
                    // This submit still owns the row (upload + confirm follow),
                    // so it is not an orphan — deleting here would 404 our own
                    // confirm. Record the anomaly; background reconciliation
                    // owns cleanup if the submit dies.
                    breadcrumb('draft', 'draft_anchor_missing_mid_submit', {
                      slot_id: slot.id,
                    });
                  }
                  dispatch({ type: 'CLEAR_DRAFT_DIRTY', slotId: slot.id });
                  if (hasNativeManifest) {
                    await durableRecorder
                      .setServerRecordingId({ userId: uid, recordingId: durable.recordingId, serverRecordingId: recordingId })
                      .catch(() => {});
                  }
                },
                onUploadProgress: ({ percent }) => {
                  const now = Date.now();
                  if (now - lastDurableProgress >= 500) {
                    lastDurableProgress = now;
                    setUploadStatus(slot.id, 'uploading', { progress: Math.round(5 + (percent * 85) / 100) });
                  }
                },
                onR2Complete: async (hint) => {
                  setUploadStatus(slot.id, 'uploading', {
                    progress: 95,
                    pendingConfirm: hint,
                  });
                  await draftStorage.updatePendingConfirm(
                    slot.draftSlotId ?? slot.id,
                    hint,
                    hint.recordingId,
                    uploadKeyForSlot(slot),
                  );
                  if (hasNativeManifest) {
                    await durableRecorder.setPendingConfirm({
                      userId: uid,
                      recordingId: durable.recordingId,
                      pendingConfirm: hint,
                    });
                  }
                },
                onClearPendingConfirm: async (reason) => {
                  const draftSlotId = slot.draftSlotId ?? slot.id;
                  const committedLateWrite =
                    reason === 'committed_late_anchor' || reason === 'committed_late_hint';
                  dispatch({ type: 'SET_PENDING_CONFIRM', slotId: slot.id, pendingConfirm: null });
                  if (committedLateWrite) {
                    // Delete the resurrected metadata first. Calling another
                    // SecureStore rewrite before deletion could hang on the same
                    // Keystore failure and prevent the repair from ever running.
                    await draftStorage.deleteDraft(draftSlotId);
                    await recoveryIntent.clearForDraftSlot(draftSlotId);
                    if (hasNativeManifest) {
                      await durableRecorder.setPendingConfirm({
                        userId: uid,
                        recordingId: durable.recordingId,
                        pendingConfirm: null,
                      });
                    }
                    return;
                  }
                  await draftStorage.updatePendingConfirm(draftSlotId, null);
                  if (hasNativeManifest) {
                    await durableRecorder.setPendingConfirm({
                      userId: uid,
                      recordingId: durable.recordingId,
                      pendingConfirm: null,
                    });
                  }
                },
                resume: slot.pendingConfirm ?? undefined,
                ...(durableUseExisting ? { existingRecordingId: durableUseExisting } : {}),
                metadataDirty: !!slot.draftMetadataDirty,
                pimsPatientIdExplicitlyCleared: isPimsPatientIdExplicitlyCleared(
                  slot.formData.pimsPatientId,
                  slot.pimsPatientIdExplicitlyCleared,
                ),
                onMetadataDivergence,
                mode: 'durable',
                audioDurationSeconds: durableDurationSeconds,
                slotIndex,
              },
            );

          completedUploadSlotIdsRef.current.add(slot.id);
          setUploadStatus(slot.id, 'success', { progress: 100, serverRecordingId: durableResult.id });
          recordSubmitAttempt(durableResult.id);

          // Post-success, strict order: write the uploaded marker FIRST, then
          // delete the draft, then (only if that succeeded) purge + tombstone.
          //
          // EXCEPT when the copy is being retained for an identity conflict.
          // markUploaded() is what makes the manifest eligible for startup
          // self-heal, so the hold has to be persisted BEFORE it — a crash in
          // between, or an ignored `false` from a failed SecureStore write,
          // would leave a confirmed manifest with no hold and the next scan
          // would purge the copy the card promised to keep.
          const holdIdentityCopy =
            (metadataDivergence as MetadataDivergenceReport | null)?.tier === 'identity';
          const identityHoldPersisted =
            holdIdentityCopy && durable && uid
              ? await addReconcileHoldForUser(uid, durable.recordingId)
              : false;
          if (holdIdentityCopy && !identityHoldPersisted) {
            // The hold could not be persisted. Do NOT terminalize the manifest:
            // an un-marked manifest is re-OFFERED by recovery (recoverable, and
            // the deterministic `durable-${recordingId}` key makes a re-submit
            // promote the same row), whereas a marked one with no hold is
            // PURGED. Between a possible duplicate and losing the only local
            // copy of a recording whose visit is already in question, this is
            // the direction to fail in.
            captureMessage('durable_identity_hold_not_persisted', 'warning', {
              tags: { phase: 'upload_recovery', mode: 'durable' },
            });
          }
          const confirmedAt = new Date().toISOString();
          if (hasNativeManifest && (!holdIdentityCopy || identityHoldPersisted)) {
            await durableRecorder
              .markUploaded({ userId: uid, recordingId: durable.recordingId, confirmedUploadAt: confirmedAt })
              .catch(() => {});
          }
          // draftStorage.deleteDraft() is best-effort and SWALLOWS its own storage
          // failures (resolves without throwing), so a try/catch can't tell whether
          // the metadata was actually removed. VERIFY via getDraft — otherwise a
          // Keystore failure would leave the draft on disk while we purge the native
          // audio.aac, stranding a "Not Submitted" card whose recording is gone.
          // Owned by draftSlotId, not slot.id — see the standard path above.
          const ownedDraftSlotId = slot.draftSlotId ?? slot.id;
          const confirmDraftGone = async (): Promise<boolean> => {
            try {
              await draftStorage.deleteDraft(ownedDraftSlotId);
              await recoveryIntent.clearForDraftSlot(ownedDraftSlotId);
            } catch {
              return false;
            }
            // Proven absence only — getDraft collapses a Keystore/chunk-read
            // failure to null, and the caller purges audio on this answer.
            const still = await draftStorage
              .draftMetadataExistsStrict(ownedDraftSlotId)
              .catch(() => 'unknown' as const);
            return still === 'missing';
          };
          // An identity-tier divergence means the server row may describe a
          // different visit. markUploaded above still ran (it is what stops
          // recovery re-offering an uploaded capture), but the destructive half
          // is held back so the reconcile card has something to preserve. This
          // is the COMMON durable path — holding it back only on the
          // pending-confirm resume branch would have left the card promising a
          // copy this branch had already destroyed.
          const holdFreshDurableCopy = holdIdentityCopy;
          if (!holdFreshDurableCopy) {
            // Retry once — most deleteDraft failures are a transient SecureStore/
            // Keystore hiccup. Stale metadata makes Home show a resumable "Not
            // Submitted" card for an already-confirmed recording; loadDraft's tombstone
            // guard + cleanupOrphaned self-heal the rest.
            let draftDeleted = await confirmDraftGone();
            if (!draftDeleted) draftDeleted = await confirmDraftGone();
            if (draftDeleted) {
              if (hasNativeManifest) {
                await durableRecorder.purgeAfterUpload({ userId: uid, recordingId: durable.recordingId }).catch(() => {});
              } else if (durable.recoveredAudioUri) {
                // Recovered vault copy — no native manifest to purge; delete the
                // neutral local .aac directly now that the server confirmed.
                safeDeleteFile(durable.recoveredAudioUri);
              }
              await durableTombstone.add(durable.recordingId).catch(() => {});
            } else {
              // deleteDraft still failed after a retry. Leave the uploaded manifest
              // for next-launch self-heal (idempotent), and tombstone so
              // cleanupOrphaned drops ONLY the stale local metadata (never the
              // uploaded server row). loadDraft's tombstone guard blocks any
              // resume-then-resubmit against the confirmed row until the sweep runs.
              await durableTombstone.add(durable.recordingId).catch(() => {});
            }
            // Release any hold this recording still carries.
            //
            // Editing a FAILED identity conflict clears `metadataDivergence`
            // (the edit-to-retry affordance in SET_FORM_FIELD) but cannot touch
            // the PERSISTED hold the conflict handler wrote — the reducer is
            // pure. When the edited retry then succeeds it lands here, deletes
            // the draft and purges the audio, and with the card gone no
            // reconciliation action remains that could ever release it. A
            // `clientName` edit clears every non-succeeded slot at once, so one
            // edit can strand several. Each leak is permanent, and `add()`
            // refuses past MAX_RECONCILE_HOLDS rather than evicting, so enough
            // of them stop a future conflict from protecting its copy at all.
            //
            // Safe here specifically because this branch is the NOT-held one:
            // an unresolved identity divergence takes the `holdFreshDurableCopy`
            // path above and never reaches this line, so the retained-copy case
            // keeps its hold. And it runs AFTER the purge, like every other
            // release — the hold must outlive the steps it protects.
            await releaseReconcileHold(durable.recordingId, 'upload_success_durable');
            await releaseReconcileHold(slot.draftSlotId ?? slot.id, 'upload_success_durable_slot');
            durableRecoveryStore.remove(durable.recordingId);
          }

          const durableLatencyMs = Date.now() - uploadStartedAt;
          trackEvent({ name: 'durable_upload_confirmed', props: { recording_id: durableResult.id } });
          trackEvent({
            name: 'submit_succeeded',
            props: {
              slot_index: slotIndex,
              segment_count: segmentCount,
              duration_s: durableDurationSeconds,
              size_bytes: durableSizeBytes,
              recording_id: durableResult.id,
              attempt_number: attemptNumber,
              latency_ms: durableLatencyMs,
              ...baseSubmitDiagnostics,
            },
          });
          uploadAttemptCountsRef.current.delete(slot.id);
          return durableResult.id;
        }

        // Pre-flight: read local segment sizes before any expensive work.
        // This gives telemetry a real byte count and lets missing/empty files
        // fail as preflight errors instead of being misclassified as silence.
        let totalBytes = 0;
        let anyOversized = false;
        try {
          const metadata = await readUploadMetadataBatch(
            slot.segments.map((segment) => segment.uri),
            'standard',
            'segment_metadata',
            getInfoAsync,
          );
          for (const info of metadata) {
            const size = info.exists ? (info.size ?? 0) : 0;
            if (!info.exists) {
              throw new Error('Failed to read the recorded audio file. Please try recording again.');
            }
            if (!size) {
              throw new Error('The recorded audio file is empty. Please try recording again.');
            }
            totalBytes += size;
            if (size > 250 * 1024 * 1024) anyOversized = true;
          }
          uploadSizeBytes = totalBytes;
          localAudioAvailableForRestart = true;
        } catch (err) {
          if (err instanceof Error && !(err as Error & { uploadPhase?: string }).uploadPhase) {
            (err as Error & { uploadPhase: 'preflight' }).uploadPhase = 'preflight';
          }
          throw err;
        }

        // Silence check runs BEFORE flipping the slot into 'uploading' state.
        // Otherwise the Upload Anyway dialog appears with the upload overlay
        // still painted behind it (slot already shows "uploading", which is
        // confusing while the user is being asked to confirm or cancel).
        const silenceCheck = await checkSilentAudio(slot);
        if (silenceCheck.inconclusive) {
          const reason =
            silenceCheck.reason === 'missing_metering_long_recording'
              ? 'missing_metering_long_recording'
              : silenceCheck.reason === 'ffmpeg_timeout'
                ? 'ffmpeg_timeout'
              : 'ffmpeg_error';
          trackEvent({
            name: 'audio_silence_check_inconclusive',
            props: {
              slot_index: slotIndex,
              duration_s: durationSeconds,
              segment_count: segmentCount,
              reason,
            },
          });
        }
        if (silenceCheck.silent) {
          // peakMetering reported by expo-audio is not always reliable on
          // certain Android devices (Pixel 10 Pro XL has been observed to
          // report depressed peaks despite clearly audible playback). Offer
          // an explicit user override so a clinician with an audible recording
          // can push it through without losing the audio capture.
          const userOverride = await confirmSilentUpload();
          if (!userOverride) {
            const silentError = new Error(
              'This recording appears silent. Please verify microphone input and record again before uploading.'
            ) as Error & { uploadPhase?: 'silent_check' };
            silentError.uploadPhase = 'silent_check';
            throw silentError;
          }
          trackEvent({
            name: 'silent_check_bypassed',
            props: {
              slot_index: slotIndex,
              duration_s: durationSeconds,
              segment_count: segmentCount,
              reason: silenceCheck.reason === 'ffmpeg_all_segments_silent'
                ? 'ffmpeg_all_segments_silent'
                : 'metering_all_below_threshold',
            },
          });
        }

        // Silence check cleared (or user overrode) — flip to 'uploading' now
        // so the upload overlay only paints once we actually intend to upload.
        setUploadStatus(slot.id, 'uploading', { progress: 1 });

        // Pre-flight: split oversized segments via FFmpeg into <250 MB parts
        // that flow through the existing createWithSegments path.
        try {
          if (anyOversized) {
            const totalDurationSec = slot.segments.reduce((sum, s) => sum + (s.duration ?? 0), 0);
            const hours = totalDurationSec / 3600;
            const mb = Math.round(totalBytes / 1024 / 1024);
            const predictedParts = Math.ceil(totalBytes / (200 * 1024 * 1024));

            const userConfirmed = await confirmOversizedUpload(hours, mb, predictedParts);
            if (!userConfirmed) {
              throw new UploadCancelledByUser();
            }

            // Sentinel [1, 5) → UploadOverlay shows "Preparing audio…"
            setUploadStatus(slot.id, 'uploading', { progress: 1 });

            const splitResult = await maybeSplitForUpload(
              slot.segments,
              { userId: user?.id ?? 'unknown', slotId: slot.id },
              (phase, current, total) => {
                if (phase === 'splitting' && total && total > 0) {
                  const pct = Math.min(4, 1 + Math.floor(((current ?? 0) / total) * 3));
                  setUploadStatus(slot.id, 'uploading', { progress: pct });
                }
              }
            );

            segmentsForUpload = splitResult.segments;
            splitTempDir = splitResult.tempDir;
            splitTempUris = splitResult.tempUris;
            uploadSizeBytes = await sumSegmentSizes(segmentsForUpload);

            breadcrumb('upload', 'oversized_split', {
              slot_index: slotIndex,
              input_size_bytes: totalBytes,
              parts: splitResult.segments.length,
              did_split: splitResult.didSplit,
            });
          }
        } catch (err) {
          if (splitTempDir) safeDeleteDirectory(splitTempDir);
          if (err instanceof UploadCancelledByUser) throw err;
          if (err instanceof Error && !(err as Error & { uploadPhase?: string }).uploadPhase) {
            (err as Error & { uploadPhase: 'preflight' }).uploadPhase = 'preflight';
          }
          throw err;
        }

        setUploadStatus(slot.id, 'uploading', { progress: 5 });
        // Throttle progress updates to avoid dispatching state on every native chunk
        let lastProgressUpdate = 0;
        const onUploadProgress = ({ percent }: { percent: number }) => {
          const now = Date.now();
          if (now - lastProgressUpdate >= 500) {
            lastProgressUpdate = now;
            setUploadStatus(slot.id, 'uploading', {
              progress: Math.round(5 + (percent * 85) / 100),
            });
          }
        };

        // Persist the resume hint as soon as R2 is done but before confirm. If the
        // confirm fails or is interrupted, a user-driven retry will flow through
        // the `resume:` branch on the API — calling only confirmUpload again
        // rather than creating a second server recording.
        const onR2Complete = async (hint: NonNullable<PatientSlot['pendingConfirm']>) => {
          setUploadStatus(slot.id, 'uploading', {
            progress: 95,
            pendingConfirm: hint,
          });
          await draftStorage.updatePendingConfirm(
            slot.draftSlotId ?? slot.id,
            hint,
            hint.recordingId,
            uploadKeyForSlot(slot),
          );
        };

        const onRecordingPrepared = async (recordingId: string) => {
          dispatch({
            type: 'SET_DRAFT_IDS',
            slotId: slot.id,
            draftSlotId: slot.draftSlotId ?? slot.id,
            serverDraftId: recordingId,
          });
          const anchorResult = await draftStorage.updateServerDraftId(
            slot.draftSlotId ?? slot.id,
            recordingId,
            uploadKeyForSlot(slot),
          );
          if (anchorResult === 'no_local_meta') {
            // Submit still owns this row — see the durable branch above.
            breadcrumb('draft', 'draft_anchor_missing_mid_submit', {
              slot_id: slot.id,
            });
          }
          dispatch({ type: 'CLEAR_DRAFT_DIRTY', slotId: slot.id });
        };

        const onClearPendingConfirm = async (reason?: string) => {
          const draftSlotId = slot.draftSlotId ?? slot.id;
          const committedLateWrite =
            reason === 'committed_late_anchor' || reason === 'committed_late_hint';
          dispatch({ type: 'SET_PENDING_CONFIRM', slotId: slot.id, pendingConfirm: null });
          if (committedLateWrite) {
            await draftStorage.deleteDraft(draftSlotId);
            await recoveryIntent.clearForDraftSlot(draftSlotId);
            return;
          }
          await draftStorage.updatePendingConfirm(draftSlotId, null);
        };

        // If we'd reuse a server draft and the user edited formData after the
        // draft was created, send those edits in confirm-upload. The server
        // applies metadata + status in one transaction or rejects the confirm.
        let useExistingDraft = !!slot.serverDraftId;
        const serverDraftId = slot.serverDraftId;
        let result;
        if (segmentsForUpload.length === 1) {
          // Single segment: use existing single-file upload (only when no
          // split happened AND original was a single segment).
          result = await recordingsApi.createWithFile(
            slot.formData,
            segmentsForUpload[0].uri,
            'audio/x-m4a',
            {
              onUploadProgress,
              onR2Complete,
              onRecordingPrepared,
              onClearPendingConfirm,
              resume: slot.pendingConfirm ?? undefined,
              idempotencyKey: uploadKeyForSlot(slot),
              ...(slot.supersededUploadKey
                ? { supersededIdempotencyKey: slot.supersededUploadKey }
                : {}),
              ...(useExistingDraft && serverDraftId ? { existingRecordingId: serverDraftId } : {}),
              metadataDirty: !!slot.draftMetadataDirty,
              pimsPatientIdExplicitlyCleared: isPimsPatientIdExplicitlyCleared(
                slot.formData.pimsPatientId,
                slot.pimsPatientIdExplicitlyCleared,
              ),
              onMetadataDivergence,
              mode: 'standard',
              audioDurationSeconds: durationSeconds,
              slotIndex,
            }
          );
        } else {
          // Multi-segment: either originally multi-segment, or split-derived
          result = await recordingsApi.createWithSegments(
            slot.formData,
            segmentsForUpload,
            'audio/x-m4a',
            {
              onUploadProgress,
              onR2Complete,
              onRecordingPrepared,
              onClearPendingConfirm,
              resume: slot.pendingConfirm ?? undefined,
              idempotencyKey: uploadKeyForSlot(slot),
              ...(slot.supersededUploadKey
                ? { supersededIdempotencyKey: slot.supersededUploadKey }
                : {}),
              ...(useExistingDraft && serverDraftId ? { existingRecordingId: serverDraftId } : {}),
              metadataDirty: !!slot.draftMetadataDirty,
              pimsPatientIdExplicitlyCleared: isPimsPatientIdExplicitlyCleared(
                slot.formData.pimsPatientId,
                slot.pimsPatientIdExplicitlyCleared,
              ),
              onMetadataDivergence,
              mode: 'standard',
              slotIndex,
            }
          );
        }
        completedUploadSlotIdsRef.current.add(slot.id);
        setUploadStatus(slot.id, 'success', {
          progress: 100,
          serverRecordingId: result.id,
        });
        // Time-to-SOAP producer: record the submit-success timestamp keyed by
        // the real server recording_id. The detail screen reads this when
        // the SOAP first renders and emits `soap_visible`. finishAt is
        // omitted here — without durable per-slot timing wiring it would
        // conflate with other slots; the submit delta is the more useful
        // product metric anyway.
        recordSubmitAttempt(result.id);
        // An identity-tier divergence means the server row may describe a
        // different visit than the one on this device. The upload itself
        // succeeded and the recording is real, so this is NOT a failed submit —
        // but the local copy is the only thing that could still be lost, so it
        // is retained until the vet reconciles. Everything else cleans up
        // normally. Never auto-delete un-sent local work.
        const holdLocalCopy =
          (metadataDivergence as MetadataDivergenceReport | null)?.tier === 'identity';
        if (holdLocalCopy && user?.id) {
          // A STANDARD held copy needs the same persistent marker a durable one
          // gets. DraftMetadata carries no divergence field, so after a restart
          // evictExpired() sees only an old draft whose server row is confirmed
          // and deletes it silently at 30 days — and a draft resumed at 29 days
          // can reach that on the very next Record mount. Keyed by draft slot
          // id here, since there is no durable recordingId to key by.
          const holdKey = slot.draftSlotId ?? slot.id;
          let standardHoldPersisted = await addReconcileHoldForUser(user.id, holdKey);
          if (!standardHoldPersisted) {
            standardHoldPersisted = await addReconcileHoldForUser(user.id, holdKey);
          }
          if (!standardHoldPersisted) {
            // Honour the result, as the durable paths do. There is no manifest
            // to leave un-terminalized here, and deleting the audio to "not
            // promise retention" would be the worst outcome of the three — so
            // the copy stays, and the promise stops being silent instead: say
            // plainly that only an answer NOW protects it, rather than letting
            // the card imply it is safe for 30 days.
            captureMessage('standard_identity_hold_not_persisted', 'warning', {
              tags: { phase: 'upload_recovery', mode: 'standard' },
            });
            Alert.alert(
              METADATA_DIVERGENCE_COPY.holdUnprotectedTitle,
              METADATA_DIVERGENCE_COPY.holdUnprotectedBody
            );
          }
        }
        if (!holdLocalCopy) {
          // Clean up local audio files now that they're safely on R2
          slot.segments.forEach((seg) => {
            safeDeleteFile(seg.uri);
          });
          // Clean up local draft after successful upload
          draftStorage.deleteDraft(slot.id).catch(() => {});
          recoveryIntent.clearForDraftSlot(slot.id).catch(() => {});
          // ...and the hold, if a cleared-by-edit conflict left one behind. Same
          // reasoning as the durable branch: this is the NOT-held path, so a
          // divergence still awaiting the vet keeps its protection.
          void releaseReconcileHold(slot.draftSlotId ?? slot.id, 'upload_success_standard');
        }
        // FFmpeg-split temp parts are derived scratch, never the only copy.
        for (const tempUri of splitTempUris) safeDeleteFile(tempUri);
        if (splitTempDir) safeDeleteDirectory(splitTempDir);

        const latencyMs = Date.now() - uploadStartedAt;
        trackEvent({
          name: 'submit_succeeded',
          props: {
            slot_index: slotIndex,
            segment_count: segmentCount,
            duration_s: durationSeconds,
            size_bytes: uploadSizeBytes,
            recording_id: result.id,
            attempt_number: attemptNumber,
            latency_ms: latencyMs,
            ...baseSubmitDiagnostics,
          },
        });
        breadcrumb('upload', 'submit_succeeded', {
          slot_index: slotIndex,
          attempt_number: attemptNumber,
          latency_ms: latencyMs,
        });
        // Reset attempt counter for this slot — any future retry starts fresh.
        uploadAttemptCountsRef.current.delete(slot.id);
        return result.id;
      } catch (error) {
        const nativePreflightTimeout = presentNativePreflightTimeout(
          error,
          captureMessage,
        );
        if (nativePreflightTimeout) {
          setUploadStatus(slot.id, 'error', {
            progress: 0,
            error: nativePreflightTimeout.copy,
          });
          // Dedicated privacy-minimal reporting only. Do not flow into the
          // submit_failed analytics/server/crash payloads or auto-stash logic.
          return null;
        }

        // User explicitly cancelled the oversize confirm dialog: do not log,
        // do not capture, leave the slot in 'pending'. They can retry later.
        if (error instanceof UploadCancelledByUser) {
          setUploadStatus(slot.id, 'pending');
          if (splitTempDir) safeDeleteDirectory(splitTempDir);
          return null;
        }

        if (error instanceof UploadIntentConflictError) {
          const canRestart =
            error.recoveryOutcome === 'restart_available' && localAudioAvailableForRestart;
          const msg = canRestart
            ? 'The server found conflicting upload state. Your audio is safe on this device; restart this upload safely to continue.'
            : 'The server found conflicting upload state. Check the upload status before taking any further action.';
          dispatch({
            type: 'SET_UPLOAD_RECOVERY',
            slotId: slot.id,
            recovery: {
              conflict: error.conflict,
              canRestart,
            },
            error: msg,
          });
          reportClientError({
            phase: error.uploadPhase,
            severity: 'warning',
            errorCode: error.code,
            message: `Upload intent conflict during ${error.conflict.stage}.`,
            recordingId: slot.serverDraftId ?? slot.serverRecordingId ?? undefined,
            slotIndex,
            segmentCount,
            durationSeconds,
            fileSizeBytes: uploadSizeBytes || undefined,
            networkState: netState,
            attemptNumber,
            submitContext: baseSubmitDiagnostics,
            uploadConflictStage: error.conflict.stage,
            uploadConflictReason: error.conflict.reason,
          });
          breadcrumb('upload', 'upload_intent_conflict', {
            slot_index: slotIndex,
            conflict_stage: error.conflict.stage,
            conflict_reason: error.conflict.reason,
            recovery_outcome: error.recoveryOutcome ?? 'not_inspected',
            can_restart: canRestart,
          });
          return null;
        }

        // The server row's identity fields disagree with this device's copy on
        // a path that was about to release the local audio. Never delete
        // anything here: surface a reconcile card and let the vet decide.
        if (error instanceof RecordingMetadataConflictError) {
          // The identity tier is a promise about THIS DEVICE: it says a local
          // copy is being retained and offers actions that act on those bytes.
          // A confirmation-only durable recovery has no readable local audio,
          // and if its adopt comparison THROWS it lands here rather than on the
          // success path — which already re-tiers exactly this case at the
          // `localAudioAvailableForRestart` check above. Without the same test
          // the card claims a device copy that does not exist, and the hold it
          // persists suppresses the uploaded manifest from ordinary recovery
          // cleanup for good. With no bytes the conflict is server-only, which
          // is what the 'unknown' tier means.
          const conflictTier =
            error.source === 'client_adopt_guard' && localAudioAvailableForRestart
              ? 'identity'
              : 'unknown';
          dispatch({
            type: 'SET_METADATA_DIVERGENCE',
            slotId: slot.id,
            divergence: {
              // Only our own adopt guard ran the tiered comparison and knows
              // the fields. A server 409 reports no tier at all.
              tier: conflictTier,
              fields: [...error.divergentFields],
              recordingId: error.recordingId,
            },
          });
          // ...and PERSIST it, exactly as the successful-upload branches do.
          // This state dies with the process while the manifest can still carry
          // serverRecordingId — so on the next launch scanDurableRecoveries()
          // verifies that row as uploaded, marks the manifest uploaded, finds no
          // hold, and self-heals: the audio behind an unresolved conflict is
          // deleted without anyone deciding.
          if (conflictTier === 'identity' && user?.id) {
            const conflictHoldKey = slot.durable?.recordingId ?? slot.draftSlotId ?? slot.id;
            let conflictHeldPersisted = await addReconcileHoldForUser(user.id, conflictHoldKey);
            if (!conflictHeldPersisted) {
              conflictHeldPersisted = await addReconcileHoldForUser(user.id, conflictHoldKey);
            }
            if (!conflictHeldPersisted) {
              // Honour the result. Without the hold this conflict exists only in
              // memory: for a durable retry whose manifest still carries the
              // server id, the next recovery scan verifies that row as uploaded,
              // marks the manifest uploaded, finds nothing protecting it, and
              // self-heals the audio away. Say so rather than implying the copy
              // is safe until the vet gets back to it.
              captureMessage('adopt_conflict_hold_not_persisted', 'warning', {
                tags: { phase: 'upload_recovery', mode: slot.durable ? 'durable' : 'standard' },
              });
              Alert.alert(
                METADATA_DIVERGENCE_COPY.holdUnprotectedTitle,
                METADATA_DIVERGENCE_COPY.holdUnprotectedBody
              );
            }
          }
        }

        // Errors crafted at our own tagged throw sites (silent_check, presign,
        // r2_put, confirm, create_draft) carry user-facing messages — keep
        // them. Everything else (native uploader internals, unexpected
        // shapes) maps to safe copy; raw detail stays in telemetry below.
        let msg: string;
        if (error instanceof ApiError || error instanceof TypeError) {
          msg = friendlyErrorMessage(error, 'upload');
        } else if (error instanceof Error && getUploadPhase(error) !== 'unknown') {
          msg = error.message;
        } else {
          msg = friendlyErrorMessage(error, 'upload');
        }
        setUploadStatus(slot.id, 'error', { progress: 0, error: msg });

        const phase = getUploadPhase(error);
        const latencyMs = Date.now() - uploadStartedAt;
        // Derive an error code usable for filtering — server-supplied codes
        // win over phase so trial/billing errors stay legible. Hermes-
        // minified class names from expo-modules-core CodedError can leak a
        // single-letter `code` in prod builds (Sentry REACT-NATIVE-4 surfaced
        // `error_code: k`); require UPPER_SNAKE-shaped codes to trust them.
        const errorObj = error as Error & { code?: string; status?: number };
        const rawCode = typeof errorObj?.code === 'string' ? errorObj.code : '';
        const looksLikeRealCode = /^[A-Z][A-Z0-9_]{2,}$/.test(rawCode);
        const errorCode =
          (looksLikeRealCode && rawCode) ||
          (errorObj?.status ? `HTTP_${errorObj.status}` : phase.toUpperCase());
        const isRecoverable = isRecoverableSubmitFailure(error);
        const telemetrySeverity = isRecoverable ? 'warning' : 'error';
        // Read the transport as of the FAILURE, not the attempt start. A
        // multi-minute upload that died because the radio dropped previously
        // still reported the transport it began on.
        const netStateAtFailure = networkStateForTelemetry();
        // PHI-free throw-site detail (field names + origin only). Rides on its
        // own property, never on error.message — the user-visible copy is set
        // from error.message just above.
        const diagnostic = getUploadDiagnostic(error);
        const failureSubmitDiagnostics =
          phase === 'patch_draft'
            ? slotSubmitDiagnostics(slot, slotCount, {
                confirmUsedAtomicMetadataUpdate: willUseAtomicMetadataUpdate,
                staleDraftPromotionBlocked: true,
              })
            : baseSubmitDiagnostics;

        trackEvent({
          name: 'submit_failed',
          props: {
            slot_index: slotIndex,
            segment_count: segmentCount,
            duration_s: durationSeconds,
            recording_id: slot.serverDraftId ?? slot.serverRecordingId ?? undefined,
            attempt_number: attemptNumber,
            error_phase: phase,
            error_code: errorCode,
            network_state: netStateAtFailure,
            network_state_at_start: netState,
            latency_ms: latencyMs,
            ...failureSubmitDiagnostics,
          },
        });
        reportClientError({
          phase,
          severity: telemetrySeverity,
          errorCode,
          message: diagnostic
            ? `Recording submission failed during ${phase}. ${diagnostic}`
            : `Recording submission failed during ${phase}.`,
          recordingId: slot.serverDraftId ?? slot.serverRecordingId ?? undefined,
          slotIndex,
          segmentCount,
          durationSeconds,
          fileSizeBytes: uploadSizeBytes || undefined,
          networkState: netStateAtFailure,
          attemptNumber,
          submitContext: failureSubmitDiagnostics,
        });
        if (!isRecoverable) {
          // Do not forward a raw API/native error message: it can contain an
          // object key, filename, signed URL, or provider detail. Safe phase
          // and outcome codes retain enough signal for grouping.
          captureException(new Error(`recording_submit_failed:${phase}:${errorCode}`), {
            tags: {
              phase,
              error_code: errorCode,
              network_state: netStateAtFailure,
              has_existing_draft: String(!!slot.serverDraftId),
              draft_metadata_dirty: String(!!slot.draftMetadataDirty),
              stale_draft_promotion_blocked: String(phase === 'patch_draft'),
            },
            extra: {
              slot_index: slotIndex,
              slot_count: slotCount,
              attempt_number: attemptNumber,
              segment_count: segmentCount,
              duration_s: durationSeconds,
              file_size_bytes: uploadSizeBytes || undefined,
              latency_ms: latencyMs,
              recording_id: slot.serverDraftId ?? slot.serverRecordingId ?? null,
              submit_context: failureSubmitDiagnostics,
              diagnostic: diagnostic ?? null,
            },
          });
        }
        breadcrumb('upload', 'submit_failed', {
          slot_index: slotIndex,
          phase,
          error_code: errorCode,
          attempt_number: attemptNumber,
        });
        // Signal auto-stash eligibility to the submit handler. Three phases
        // qualify, all characterized by a dead network mid-submit that the
        // user can recover from by re-submitting once online:
        //   - r2_put: transient exhaustion after all 3 retries (Sentry
        //     REACT-NATIVE-4 fingerprint).
        //   - create_draft: fetch() throws `Network request failed` while
        //     POSTing the draft row or validating an existing serverDraftId
        //     (Sentry REACT-NATIVE-C fingerprint, multi-patient Submit-All on
        //     offline tablet).
        //   - prepare: the atomic prepare-upload request itself failed before
        //     any storage PUT. The stable intent makes a later retry safe.
        // presign / preflight / silence / confirm failures stay excluded —
        // those represent local-file / metering / server-side state problems
        // that won't resolve just by stashing and retrying when back online.
        if (isTransientUploadError(error)) {
          if (phase === 'r2_put') {
            autoStashableFailuresRef.current.set(slot.id, 'r2_put_dead_network');
          } else if (phase === 'create_draft') {
            autoStashableFailuresRef.current.set(slot.id, 'create_draft_dead_network');
          } else if (phase === 'prepare') {
            autoStashableFailuresRef.current.set(slot.id, 'prepare_dead_network');
          }
        }
        return null;
      }
      } finally {
        uploadingSlotIdsRef.current.delete(slot.id);
        keepAwakeLease.release();
        if (durableSnapshotUri) safeDeleteFile(durableSnapshotUri);
        for (const tempUri of splitTempUris) safeDeleteFile(tempUri);
        if (splitTempDir) safeDeleteDirectory(splitTempDir);
      }
    },
    // The exhaustive-deps suppression that used to sit here existed because
    // networkStateForTelemetry closed over `netInfo` directly — which is exactly
    // why the reported transport was the one the upload STARTED on. It now reads
    // netInfoRef, so the dep list is genuinely complete and the rule is silent.
    [addReconcileHoldForUser, setUploadStatus, dispatch, user?.id, user?.role, releaseReconcileHold]
  );

  // Phase 2 of autoSaveDraft — the network half. Patches an existing draft in
  // place, or creates a fresh one. Reads the slot from sessionRef to avoid
  // acting on a stale snapshot captured at schedule time. Guarded by the same
  // race refs as before so a Submit or completed upload during the await
  // aborts before leaving a ghost draft row behind.
  const syncServerDraft = useCallback(
    async (slotId: string, draftSlotId: string) => {
      if (uploadRestartSlotIdsRef.current.has(slotId)) return;
      const initiatingUserId = user?.id;
      const initiatingRole = user?.role;
      const initiatingScopeKey = authScopeKeyRef.current;
      const initiatingScopeGeneration = authScopeGenerationRef.current;
      if (!initiatingUserId || !initiatingScopeKey) return;
      const scopeIsCurrent = () =>
        authScopeMountedRef.current &&
        authScopeKeyRef.current === initiatingScopeKey &&
        authScopeGenerationRef.current === initiatingScopeGeneration &&
        draftStorage.getUserId() === initiatingUserId;
      if (!scopeIsCurrent()) return;

      // Serialize, rather than drop, a newer sync for the same slot. Each
      // queued operation reads sessionRef only when its turn begins, so edits
      // made while an older PATCH/POST is in flight are included. The promise
      // tail also gives stash flushing a concrete operation to await.
      const previous =
        draftSyncPromiseBySlotRef.current.get(slotId) ?? Promise.resolve();
      draftSyncInFlightSlotIdsRef.current.add(slotId);
      const operation = previous
        .catch(() => {
          // A failed predecessor must not poison the per-slot queue. The
          // operation itself reports/captures its bounded failure below.
        })
        .then(async () => {
          const awaitScoped = async <T,>(operation: () => Promise<T>): Promise<T> => {
            if (!scopeIsCurrent()) {
              throw new Error('Draft sync authentication scope changed');
            }
            const value = await operation();
            if (!scopeIsCurrent()) {
              throw new Error('Draft sync authentication scope changed');
            }
            return value;
          };
          try {
            if (!scopeIsCurrent() || !canRecordAppointments(initiatingRole)) return;
            const slot = sessionRef.current.slots.find((s) => s.id === slotId);
            if (!slot) return;
            // Replacement identities are valid only through the controlled
            // upload-intent recovery endpoint. Check both the in-memory slot and
            // the persisted two-phase marker before any background server write.
            if (slot.supersededUploadKey || uploadRestartSlotIdsRef.current.has(slotId)) return;
            const persistedDraft = await awaitScoped(() => draftStorage.getDraft(draftSlotId));
            if (persistedDraft?.supersededUploadKey || persistedDraft?.uploadRestartPending) return;
            if (completedUploadSlotIdsRef.current.has(slotId)) {
              // ...unless the upload deliberately RETAINED the local copy for an
              // unresolved identity divergence. The upload marks the slot
              // completed either way, so without this the background persist
              // saves the held draft and this branch immediately deletes the
              // draft and audio it just wrote — destroying the copy the
              // reconciliation card promises to keep.
              if (slot.metadataDivergence?.tier === 'identity') return;
              await awaitScoped(() => draftStorage.deleteDraft(slotId).catch(() => {}));
              await awaitScoped(() => recoveryIntent.clearForDraftSlot(slotId).catch(() => {}));
              return;
            }
            if (!isConnected || submitIntentSlotIdsRef.current.has(slotId)) return;

            let serverId: string | null = null;
            let createdFreshServerRow = false;
            if (slot.serverDraftId) {
              const outcome = await awaitScoped(() =>
                patchDraftMetadataWithRetry(
                  slot.serverDraftId!,
                  slot.formData,
                  undefined,
                  scopeIsCurrent,
                ),
              );
              if (outcome === 'success') {
                serverId = slot.serverDraftId;
              } else if (outcome === 'draft_missing') {
                // 404 from the server — the draft genuinely no longer exists
                // (e.g. deleted from another device). Fall through to fresh create.
                if (__DEV__) console.warn('[Record] syncServerDraft: draft missing on server, creating fresh', slot.serverDraftId);
              } else {
                // Keep draftMetadataDirty=true. A later Submit must either sync the
                // latest metadata or fail closed before promotion, even after restart.
                await awaitScoped(() => draftStorage.markDraftMetadataDirty(slotId));
                if (!scopeIsCurrent()) return;
                dispatch({ type: 'MARK_DRAFT_METADATA_DIRTY', slotId });
                breadcrumb('draft', 'sync_server_draft_metadata_not_synced', {
                  slot_id: slotId,
                  outcome,
                });
                return;
              }

              if (completedUploadSlotIdsRef.current.has(slotId)) {
                await awaitScoped(() => draftStorage.deleteDraft(slotId).catch(() => {}));
                await awaitScoped(() => recoveryIntent.clearForDraftSlot(slotId).catch(() => {}));
                return;
              }
              if (submitIntentSlotIdsRef.current.has(slotId)) return;
            }

            if (!serverId) {
              if (submitIntentSlotIdsRef.current.has(slotId)) return;
              if (uploadRestartSlotIdsRef.current.has(slotId)) return;
              const latestDraft = await awaitScoped(() => draftStorage.getDraft(draftSlotId));
              if (latestDraft?.supersededUploadKey || latestDraft?.uploadRestartPending) return;
              // A durable slot MUST create with a deterministic idempotency key
              // derived from its on-disk durable recordingId, so a later Submit
              // (which reuses `durable-${recordingId}`) promotes THIS row instead of
              // fresh-creating a duplicate if the app dies before updateServerDraftId
              // lands. Also persist serverRecordingId into the manifest as the
              // death-surviving anchor. Mirrors the submit path + usePendingDraftSync.
              const durableRecordingId = slot.durable?.recordingId;
              const result = await awaitScoped(() =>
                recordingsApi.create(slot.formData, {
                  isDraft: true,
                  idempotencyKey: uploadKeyForSlot(slot),
                }),
              );
              serverId = result.id;
              createdFreshServerRow = true;
              if (durableRecordingId) {
                await awaitScoped(() =>
                  durableRecorder.setServerRecordingId({
                    userId: initiatingUserId,
                    recordingId: durableRecordingId,
                    serverRecordingId: result.id,
                  }).catch(() => {}),
                );
              }

              if (submitIntentSlotIdsRef.current.has(slotId) || completedUploadSlotIdsRef.current.has(slotId)) {
                // The Finish-time create and Submit share one persistent upload
                // intent. A racing create can therefore return the exact canonical
                // row Submit is preparing, uploading, or has already completed.
                // Deleting it here would recreate the stale-row 404 window this
                // protocol closes. Leave the server winner intact; only transient
                // local draft state may be removed after proven upload success.
                // Same retention exemption as above.
                if (
                  completedUploadSlotIdsRef.current.has(slotId) &&
                  slot.metadataDivergence?.tier !== 'identity'
                ) {
                  await awaitScoped(() => draftStorage.deleteDraft(slotId).catch(() => {}));
                  await awaitScoped(() => recoveryIntent.clearForDraftSlot(slotId).catch(() => {}));
                }
                return;
              }
            }

            if (!scopeIsCurrent()) return;
            dispatch({ type: 'SET_DRAFT_IDS', slotId, draftSlotId, serverDraftId: serverId });
            const anchorResult = await awaitScoped(() =>
              draftStorage.updateServerDraftId(draftSlotId, serverId),
            );
            if (!scopeIsCurrent()) return;
            if (
              anchorResult === 'no_local_meta' &&
              // Only a row THIS pass created can be an unanchored orphan. A
              // pre-existing server draft (patch branch) is owned by the
              // snapshot-driven reconciliation/orphan-cleanup flows instead.
              createdFreshServerRow &&
              !submitIntentSlotIdsRef.current.has(slotId) &&
              !completedUploadSlotIdsRef.current.has(slotId) &&
              // A durable slot keeps a death-surviving anchor in its native
              // manifest and re-promotes this row via `durable-${recordingId}`
              // — the row is not orphaned, so it must not be deleted.
              !slot.durable?.recordingId
            ) {
              // Fresh background create whose local anchor vanished before it
              // persisted: the row has no owner and would strand forever
              // (Sentry REACT-NATIVE-1F). Status-preconditioned: a row a
              // racing Submit claimed via the shared idempotency key is no
              // longer 'draft' after confirm and is left alone. Best-effort;
              // a transient failure hands the id to the pending-sync retry
              // queue (nothing local can rediscover it otherwise).
              const cleanupOutcome = await awaitScoped(() =>
                recordingsApi.deleteOrphanDraftIfUnclaimed(serverId!),
              );
              if (cleanupOutcome === 'failed' && initiatingUserId) {
                rememberOrphanDraftId(initiatingUserId, serverId!);
              }
              if (!scopeIsCurrent()) return;
              // The SET_DRAFT_IDS above anchored this slot to the row we just
              // deleted — clear it, or the next recording in this slot would
              // try to promote a deleted draft on Submit.
              dispatch({ type: 'SET_DRAFT_IDS', slotId, draftSlotId, serverDraftId: null });
              return;
            }
            invalidateRecordingCaches(queryClient, 'draft_changed');
          } catch (error) {
            // Auth may have switched while this operation waited behind another
            // slot sync or awaited storage/network. Never inspect, mutate, or
            // report the replacement user's state on behalf of the old scope.
            if (!scopeIsCurrent()) return;
            const hadServerDraft = !!sessionRef.current.slots.find((s) => s.id === slotId)?.serverDraftId;
            if (hadServerDraft) {
              try {
                await awaitScoped(() => draftStorage.markDraftMetadataDirty(slotId));
              } catch {
                return;
              }
              if (!scopeIsCurrent()) return;
              dispatch({ type: 'MARK_DRAFT_METADATA_DIRTY', slotId });
            }
            if (isNetworkRequestFailed(error)) {
              breadcrumb('draft', 'sync_server_draft_transient_network', {
                slot_id: slotId,
                had_server_draft: hadServerDraft,
              });
              return;
            }
            // Phase 2 of draft persistence. Failure here means the local draft
            // exists but never reached the server — silent in prod before this
            // capture call. Tag with phase so it groups separately from
            // auto_save_draft (Phase 1) in Sentry.
            captureException(error, {
              tags: { phase: 'sync_server_draft' },
              extra: {
                slot_id: slotId,
                had_server_draft: hadServerDraft,
              },
            });
            if (__DEV__) console.warn('[Record] syncServerDraft failed:', error);
          }
        });

      draftSyncPromiseBySlotRef.current.set(slotId, operation);
      const clearIfTail = () => {
        if (draftSyncPromiseBySlotRef.current.get(slotId) === operation) {
          draftSyncPromiseBySlotRef.current.delete(slotId);
          draftSyncInFlightSlotIdsRef.current.delete(slotId);
        }
      };
      // Register cleanup before any external waiter so flushScheduledDraft can
      // observe an empty map immediately after the tail settles.
      void operation.then(clearIfTail, clearIfTail);
      await operation;
    },
    [dispatch, isConnected, queryClient, user?.id, user?.role]
  );

  // Schedule phase 2. With DRAFT_DEBOUNCE_MS > 0, delays the server POST so
  // the user can Submit first and skip creating a draft row altogether — the
  // primary fix for the "completed + Not Submitted" duplicate pattern. With
  // DRAFT_DEBOUNCE_MS = 0, runs immediately (legacy behavior).
  const scheduleDraftSync = useCallback(
    (slotId: string, draftSlotId: string) => {
      // Replace any pending timer for this slot (e.g. stop → continue → stop
      // in quick succession should coalesce into one sync).
      const existing = pendingDraftTimersRef.current.get(slotId);
      if (existing) clearTimeout(existing);

      if (DRAFT_DEBOUNCE_MS <= 0) {
        pendingDraftTimersRef.current.delete(slotId);
        syncServerDraft(slotId, draftSlotId).catch(() => {});
        return;
      }

      const timer = setTimeout(() => {
        pendingDraftTimersRef.current.delete(slotId);
        if (submitIntentSlotIdsRef.current.has(slotId) || completedUploadSlotIdsRef.current.has(slotId)) {
          // User beat the debounce — no server row needed.
          return;
        }
        syncServerDraft(slotId, draftSlotId).catch(() => {});
      }, DRAFT_DEBOUNCE_MS);
      pendingDraftTimersRef.current.set(slotId, timer);
    },
    [syncServerDraft]
  );

  // Force pending syncs to run now (used before stash, which snapshots state
  // to disk — a missing serverDraftId would mean the resumed session creates
  // a fresh row on submit instead of promoting).
  const flushScheduledDraft = useCallback(
    async (slotId: string): Promise<void> => {
      const timer = pendingDraftTimersRef.current.get(slotId);
      if (timer) {
        clearTimeout(timer);
        pendingDraftTimersRef.current.delete(slotId);
        const slot = sessionRef.current.slots.find((s) => s.id === slotId);
        if (slot?.draftSlotId) {
          await syncServerDraft(slotId, slot.draftSlotId);
        }
      }

      // A debounce callback may already have consumed its timer and entered
      // the queue. Do not let stash snapshot/delete local state until the
      // complete per-slot sync tail (including any newer queued edit) settles.
      while (true) {
        const active = draftSyncPromiseBySlotRef.current.get(slotId);
        if (!active) return;
        await active;
      }
    },
    [syncServerDraft]
  );

  const autoSaveDraft = useCallback(
    async (slot: PatientSlot) => {
      const initiatingUserId = user?.id;
      const initiatingScopeKey = authScopeKeyRef.current;
      const initiatingScopeGeneration = authScopeGenerationRef.current;
      if (!initiatingUserId || !initiatingScopeKey) return false;
      const scopeIsCurrent = () =>
        authScopeMountedRef.current &&
        authScopeKeyRef.current === initiatingScopeKey &&
        authScopeGenerationRef.current === initiatingScopeGeneration &&
        draftStorage.getUserId() === initiatingUserId;
      // Once restart owns the slot, an ordinary snapshot must not queue behind
      // it and overwrite the replacement identity after the transaction.
      if (!scopeIsCurrent() || uploadRestartSlotIdsRef.current.has(slot.id)) return false;
      const previous =
        localDraftSavePromiseBySlotRef.current.get(slot.id) ?? Promise.resolve(true);
      const operation = previous
        .catch(() => false)
        .then(async () => {
          if (!scopeIsCurrent() || uploadRestartSlotIdsRef.current.has(slot.id)) return false;
          const awaitScoped = async <T,>(operation: () => Promise<T>): Promise<T> => {
            if (!scopeIsCurrent()) throw new Error('Local draft save authentication scope changed');
            const value = await operation();
            if (!scopeIsCurrent()) throw new Error('Local draft save authentication scope changed');
            return value;
          };
          // Guard bookkeeping: while this save is in flight (or after it fails),
          // the slot's newest audio exists only in session state, so the
          // discard/replace guards must not treat draftSlotId as proof of safety.
          unsyncedDraftAudioRef.current.add(slot.id);
          try {
            // Phase 1: persist the local draft (audio + metadata). Always runs
            // regardless of connectivity so the user can resume offline.
            const { draftSlotId, promotedSegments } = await awaitScoped(() =>
              draftStorage.saveDraft(slot),
            );
            // Promote session-state segment URIs to the durable draft copies. This
            // is the core RN-8 fix (docs/2026-05-17-promote-segments-to-draft.md):
            // without this, slot.segments[].uri keeps pointing at recorder-temp
            // paths that the OS can reap between Finish and a later re-save,
            // making every subsequent saveDraft loop fail with `copy_threw`. The
            // length guard skips promotion on a partial saveDraft success — the
            // wipe-on-resave guard (PR #46) keeps the on-disk draft intact and
            // the next successful re-save can promote all-or-nothing. Dispatch
            // BEFORE SET_DRAFT_IDS so any subsequent read from sessionRef sees
            // the durable URIs before scheduleDraftSync snapshots the slot.
            if (promotedSegments.length === slot.segments.length) {
              dispatch({
                type: 'PROMOTE_SEGMENTS_TO_DRAFT',
                slotId: slot.id,
                segments: promotedSegments,
              });
            } else if (__DEV__) {
              console.warn('[Record] segment-count mismatch in autoSaveDraft promotion', {
                input: slot.segments.length,
                promoted: promotedSegments.length,
              });
            }
            // Preserve the existing serverDraftId here — the server draft (if any)
            // still represents this slot's recording. Nulling it would orphan the
            // server row on every stop/continue cycle.
            dispatch({
              type: 'SET_DRAFT_IDS',
              slotId: slot.id,
              draftSlotId,
              serverDraftId: slot.serverDraftId ?? null,
              preserveDirty: !!slot.serverDraftId && slot.draftMetadataDirty,
            });
            const recoveryReason =
              pendingDraftRecoveryReasonRef.current.get(slot.id) ?? 'draft_finish';
            pendingDraftRecoveryReasonRef.current.delete(slot.id);
            await awaitScoped(() =>
              recoveryIntent.save({
                userId: initiatingUserId,
                draftSlotId,
                reason: recoveryReason,
              }),
            );
            if (!scopeIsCurrent()) return false;
            invalidateRecordingCaches(queryClient, 'draft_changed');

            // Local persistence succeeded — the current audio snapshot is durable
            // and draftSlotId identifies a real local draft again.
            unsyncedDraftAudioRef.current.delete(slot.id);
            stashResumedSlotIdsRef.current.delete(slot.id);

            if (completedUploadSlotIdsRef.current.has(slot.id)) {
              // ...unless the upload RETAINED this copy. The background persist
              // deliberately includes a held slot, and saveDraft has just
              // promoted live state onto the draft-directory URIs — so deleting
              // here removes the directory it only just wrote and takes the
              // retained audio with it. The server-sync branches already carry
              // this exemption; this one did not.
              if (slot.metadataDivergence?.tier !== 'identity') {
                deleteLocalSlotDraft(slot);
              }
              return true;
            }

            if (
              !isConnected ||
              submitIntentSlotIdsRef.current.has(slot.id) ||
              uploadRestartSlotIdsRef.current.has(slot.id)
            ) {
              return true;
            }

            // Phase 2: server sync. Debounced so a user who immediately taps
            // Submit never writes a draft row to the server.
            scheduleDraftSync(slot.id, draftSlotId);
            return true;
          } catch (error) {
            if (!scopeIsCurrent()) return false;
            // Draft save is best-effort — never surface errors to the user.
            // The recording is still in session state and can still be submitted.
            // Capture to Sentry so empty-segment / dir-creation failures surface
            // in production (the previous DEV-only warn was invisible on prod
            // builds and let the orphan-draft bug hide).
            captureException(error, {
              tags: { phase: 'auto_save_draft' },
              extra: {
                slot_id: slot.id,
                segment_count: slot.segments.length,
                has_server_draft: !!slot.serverDraftId,
              },
            });
            if (__DEV__) console.warn('[Record] autoSaveDraft failed:', error);
            return false;
          }
        });

      localDraftSavePromiseBySlotRef.current.set(slot.id, operation);
      const clearIfTail = () => {
        if (localDraftSavePromiseBySlotRef.current.get(slot.id) === operation) {
          localDraftSavePromiseBySlotRef.current.delete(slot.id);
        }
      };
      void operation.then(clearIfTail, clearIfTail);
      return operation;
    },
    [deleteLocalSlotDraft, dispatch, isConnected, queryClient, scheduleDraftSync, user?.id]
  );

  autoSaveDraftRef.current = autoSaveDraft;

  const flushLocalDraftSave = useCallback(async (slotId: string): Promise<void> => {
    while (true) {
      const active = localDraftSavePromiseBySlotRef.current.get(slotId);
      if (!active) return;
      await active.catch(() => false);
    }
  }, []);

  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      try {
        const previousState = appStateRef.current;
        appStateRef.current = nextState;

        if (
          previousState === 'active' &&
          (nextState === 'inactive' || nextState === 'background')
        ) {
          // Do not stop the live recorder on screen lock/background. Android may
          // only allow microphone capture while the already-started foreground
          // service is running; stopping here and waiting for AppState 'active'
          // to restart drops the rest of a screen-off exam. We only persist
          // drafts for slots that already have captured segments.
          persistSessionDraftsForBackground().catch(() => {});
        }

        // Resume from interruption (incoming call, Siri) when the user returns.
        // Short delay because iOS' AVAudioSession needs ~500ms after the call
        // ends before `setActive(true)` can succeed; bypassing this leads to
        // OSStatus -50 / "session not active" on the very next prepareToRecord.
        if (
          nextState === 'active' &&
          previousState !== 'active' &&
          interruptionPendingResumeRef.current
        ) {
          const resume = interruptionPendingResumeRef.current;
          interruptionPendingResumeRef.current = null;
          setTimeout(() => {
            try {
              startRecordingRef.current(resume.slotId);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
              breadcrumb('record', 'interruption_resumed', { slot_id: resume.slotId });
            } catch (e) {
              if (__DEV__) console.error('[Record] interruption auto-resume failed', e);
            } finally {
              setInterruptionPendingResume(null);
            }
          }, 500);
        }
      } catch (error) {
        if (__DEV__) console.error('[Record] AppState handler failed:', error);
        captureException(error, { tags: { phase: 'record_app_state_change' } });
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => {
      subscription.remove();
    };
  }, [persistSessionDraftsForBackground]);

  // Effect: auto-save draft after segment-affecting state updates have been
  // processed by React. The ref is set after audio capture and editor commits,
  // but the actual save is deferred until session.slots reflects the new
  // segment list.
  useEffect(() => {
    if (pendingDraftSlotIdRef.current) {
      const slotId = pendingDraftSlotIdRef.current;
      const slot = session.slots.find((s) => s.id === slotId);
      const minSegmentCount = pendingDraftMinSegmentCountRef.current;
      // Durable slots have empty segments[] (audio in audio.aac) — save once the
      // durable ref is attached; segment slots wait for the segment list.
      const ready = slot
        ? slot.durable
          ? true
          : slot.segments.length > 0 && slot.segments.length >= minSegmentCount
        : false;
      if (slot && ready) {
        pendingDraftSlotIdRef.current = null;
        pendingDraftMinSegmentCountRef.current = 0;
        autoSaveDraft(slot).catch(() => {});
      }
    }
  }, [session, autoSaveDraft]);

  /**
   * Auto-stash recovery for transient R2 upload exhaustion (Sentry
   * REACT-NATIVE-4 fingerprint). Invoked when `uploadSlot` returns null
   * AND set the slot's id in `autoStashableFailuresRef`. Mirrors the success
   * path of `executeStash` but with copy that explains the network angle and
   * emits one `recording_auto_stashed` event per slot we actually saved, so
   * dashboards can count affected recordings rather than user-level
   * aggregation.
   *
   * Returns true if a stash committed (caller should suppress the generic
   * "upload failed" alert + nav home), false if no slots were eligible or
   * stashSession refused — caller falls back to its existing failure UX.
   */
  const tryAutoStashOnNetworkDeath = useCallback(
    async (candidateSlotIds: string[]): Promise<boolean> => {
      const eligible: { id: string; reason: AutoStashReason }[] = [];
      for (const id of candidateSlotIds) {
        const reason = autoStashableFailuresRef.current.get(id);
        if (reason) eligible.push({ id, reason });
      }
      if (eligible.length === 0) return false;
      // Consume the flags so a later retry doesn't auto-stash again on a
      // different failure mode that happens to leave them set.
      eligible.forEach(({ id }) => autoStashableFailuresRef.current.delete(id));

      const session = sessionRef.current;
      const success = await stashSession(session);
      if (!success) return false;

      session.slots.forEach((slot) => deleteLocalSlotDraft(slot));

      for (const { id, reason } of eligible) {
        const idx = session.slots.findIndex((s) => s.id === id);
        const slot = session.slots[idx];
        if (!slot) continue;
        trackEvent({
          name: 'recording_auto_stashed',
          props: {
            reason,
            slot_index: idx,
            segment_count: slot.segments.length,
            duration_s: Math.round(
              slot.segments.reduce((sum, s) => sum + (s.duration ?? 0), 0)
            ),
          },
        });
      }

      releaseResumedStashIfAny();
      resetSession();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      Alert.alert(STASH_COPY.autoSavedTitle, STASH_COPY.autoSavedBody);
      return true;
    },
    [
      stashSession,
      releaseResumedStashIfAny,
      resetSession,
      deleteLocalSlotDraft,
    ]
  );

  const recordSelectedSlotUploadNull = useCallback((slotId: string, source: 'single' | 'all') => {
    const failedSnapshot = sessionRef.current.slots.find((s) => s.id === slotId);
    const slotIndex = sessionRef.current.slots.findIndex((s) => s.id === slotId);
    breadcrumb('upload', 'submit_selected_slot_returned_null', {
      source,
      slot_index: slotIndex,
      has_durable: !!failedSnapshot?.durable,
      segment_count: failedSnapshot?.segments.length ?? 0,
      audio_state: failedSnapshot?.audioState ?? 'missing',
      has_server_draft: !!failedSnapshot?.serverDraftId,
      has_pending_confirm: !!failedSnapshot?.pendingConfirm,
    });
  }, []);

  const rotateDurableAudioIdentity = useCallback(
    async (slot: PatientSlot): Promise<string | null> => {
      const userId = user?.id;
      const initiatingScopeKey = authScopeKeyRef.current;
      const initiatingScopeGeneration = authScopeGenerationRef.current;
      if (
        !slot.durable ||
        !userId ||
        !initiatingScopeKey ||
        uploadRestartSlotIdsRef.current.has(slot.id) ||
        draftSyncInFlightSlotIdsRef.current.has(slot.id)
      ) {
        return null;
      }

      const scopeIsCurrent = () =>
        authScopeMountedRef.current &&
        authScopeKeyRef.current === initiatingScopeKey &&
        authScopeGenerationRef.current === initiatingScopeGeneration &&
        draftStorage.getUserId() === userId;
      if (!scopeIsCurrent()) return null;

      const expectedOldKey = uploadKeyForSlot(slot);
      const freshAudioUploadKey = createAudioChangeUploadIdempotencyKey();
      const draftSlotId = slot.draftSlotId ?? slot.id;
      markUploadRestart(slot.id);
      cancelScheduledDraft(slot.id);
      let timedOut = false;
      let watchdog: ReturnType<typeof setTimeout> | null = null;

      try {
        const transaction = (async (): Promise<string | null> => {
          const awaitStep = async <T,>(operation: () => Promise<T>): Promise<T> => {
            if (!scopeIsCurrent()) {
              throw new Error('Durable audio identity user scope changed');
            }
            const value = await operation();
            if (!scopeIsCurrent()) {
              throw new Error('Durable audio identity user scope changed');
            }
            return value;
          };

          // A background/Finish auto-save may still own an older slot snapshot.
          // Restart already blocks new saves; wait for the existing queue tail
          // before persisting and rotating the authoritative identity.
          await awaitStep(() => flushLocalDraftSave(slot.id));

          // Persist the current metadata snapshot even when a draft already
          // exists. The old draft can lag behind patient edits; committing a
          // fresh native identity against that stale snapshot would restore
          // incorrect metadata after process death.
          const snapshotSlot =
            draftSlotId === slot.id ? slot : { ...slot, id: draftSlotId };
          const saved = await awaitStep(() =>
            draftStorage.saveDraft(snapshotSlot, { requireCompleteAudio: true }),
          );
          const persistedDraftSlotId = saved.draftSlotId;

          const began = await awaitStep(() =>
            draftStorage.beginUploadAttemptReset(
              persistedDraftSlotId,
              expectedOldKey,
              freshAudioUploadKey,
            ),
          );
          if (!began) return null;

          let draftCommitted = false;
          try {
            await awaitStep(() =>
              durableRecorder.resetUploadAttempt({
                userId,
                recordingId: slot.durable!.recordingId,
                expectedOldKey,
                replacementKey: freshAudioUploadKey,
              }),
            );
          } catch (error) {
            if (!scopeIsCurrent()) throw error;
            // The native response can be lost after its atomic rename.
            // Reconcile from the authoritative manifest before deciding
            // whether Continue may append bytes.
            const manifest = await awaitStep(() =>
              durableRecorder
                .getManifest({ userId, recordingId: slot.durable!.recordingId })
                .catch(() => null),
            );
            const reconciled = manifest
              ? await awaitStep(() =>
                  draftStorage.reconcileUploadAttemptReset(
                    persistedDraftSlotId,
                    manifest.uploadKeyOverride,
                    manifest.supersededUploadKey,
                  ),
                )
              : 'blocked';
            if (reconciled !== 'committed') throw error;
            draftCommitted = true;
          }

          if (!draftCommitted) {
            draftCommitted = await awaitStep(() =>
              draftStorage.commitUploadAttemptReset(
                persistedDraftSlotId,
                expectedOldKey,
                freshAudioUploadKey,
              ),
            );
          }
          if (!draftCommitted || !scopeIsCurrent()) return null;

          // Keep live state aligned even if the UI watchdog already returned.
          // A timed-out native call may still have atomically committed; the
          // next Continue can safely reuse this fresh ordinary identity.
          dispatch({
            type: 'RESET_UPLOAD_ATTEMPT',
            slotId: slot.id,
            uploadKeyOverride: freshAudioUploadKey,
            supersededUploadKey: null,
          });
          return freshAudioUploadKey;
        })();

        const timeoutResult = new Promise<null>((resolve) => {
          watchdog = setTimeout(() => {
            timedOut = true;
            captureMessage('durable_audio_identity_watchdog_fired', 'warning', {
              tags: { phase: 'upload_recovery', mode: 'durable_continue' },
            });
            resolve(null);
          }, UPLOAD_RESTART_LOCAL_TIMEOUT_MS);
        });
        const result = await Promise.race([transaction, timeoutResult]);
        if (timedOut) {
          // The native/SecureStore operation cannot be cancelled. Retain the
          // coordination guard until it settles; the transaction will align
          // live state if its atomic identity update committed late.
          transaction.then(
            () => clearUploadRestart(slot.id),
            () => clearUploadRestart(slot.id),
          );
        }
        return result;
      } finally {
        if (watchdog) clearTimeout(watchdog);
        if (!timedOut) {
          clearUploadRestart(slot.id);
        }
      }
    },
    [cancelScheduledDraft, clearUploadRestart, dispatch, flushLocalDraftSave, markUploadRestart, user?.id],
  );
  rotateDurableAudioIdentityRef.current = rotateDurableAudioIdentity;

  const persistControlledUploadRestart = useCallback(
    async (slot: PatientSlot): Promise<PatientSlot | null> => {
      // Also reachable from the metadata-divergence reconcile card: "not this
      // visit" needs exactly this — a rotated upload intent with the local
      // audio preserved — and reusing it keeps the transaction, auth-scope
      // checks, watchdog, and draft persistence rather than reimplementing them.
      // 'unknown' is here for the SERVER's 409: prepare/confirm rejected the
      // metadata without saying which field disagreed, so the vet has no way to
      // edit their way out — and a retry reuses the same upload intent and
      // collects the same 409 forever. Rotating the intent is the only exit,
      // and it is behind the same explicit confirmation as the identity tier.
      const restartAllowed =
        slot.uploadRecovery?.canRestart === true ||
        slot.metadataDivergence?.tier === 'identity' ||
        slot.metadataDivergence?.tier === 'unknown';
      if (!restartAllowed) return null;
      const userId = user?.id;
      const initiatingScopeKey = authScopeKeyRef.current;
      const initiatingScopeGeneration = authScopeGenerationRef.current;
      if (!userId || !initiatingScopeKey) return null;
      const scopeIsCurrent = () =>
        authScopeMountedRef.current &&
        authScopeKeyRef.current === initiatingScopeKey &&
        authScopeGenerationRef.current === initiatingScopeGeneration &&
        draftStorage.getUserId() === userId;
      if (!scopeIsCurrent()) return null;
      const expectedOldKey = uploadKeyForSlot(slot);
      if (
        uploadRestartSlotIdsRef.current.has(slot.id) ||
        draftSyncInFlightSlotIdsRef.current.has(slot.id)
      ) {
        return null;
      }
      markUploadRestart(slot.id);
      cancelScheduledDraft(slot.id);
      const replacementKey = createRestartUploadIdempotencyKey();
      const draftSlotId = slot.draftSlotId ?? slot.id;
      let timedOut = false;
      let watchdog: ReturnType<typeof setTimeout> | null = null;

      try {
        const transaction = (async (): Promise<PatientSlot | null> => {
          const awaitStep = async <T,>(promise: Promise<T>): Promise<T> => {
            const value = await promise;
            if (!scopeIsCurrent()) {
              throw new Error('Upload restart authentication scope changed');
            }
            return value;
          };

          // The upload restart guard rejects new ordinary saves. Drain any
          // phase-1 save that captured the old slot before writing the exact
          // restart snapshot and rotating SecureStore/native identity.
          await awaitStep(flushLocalDraftSave(slot.id));

          // Always persist the exact current audio snapshot before rotating the
          // identity. An existing draft can lag behind an edit/Continue save, so
          // merely checking that metadata exists could restore older bytes after
          // process death under the new replacement key.
          const snapshotSlot =
            draftSlotId === slot.id ? slot : { ...slot, id: draftSlotId };
          const saved = await awaitStep(
            draftStorage.saveDraft(snapshotSlot, {
              requireCompleteAudio: true,
            }),
          );
          if (!slot.durable && saved.promotedSegments.length !== slot.segments.length) {
            throw new Error('Draft storage did not preserve every current audio segment');
          }
          const persistedSlot: PatientSlot = {
            ...slot,
            draftSlotId: saved.draftSlotId,
            segments: slot.durable ? slot.segments : saved.promotedSegments,
          };

          let draftReset = false;
          if (slot.durable) {
            const manifest = await awaitStep(
              durableRecorder
                .getManifest({ userId, recordingId: slot.durable.recordingId })
                .catch(() => null),
            );
            if (manifest) {
              const began = await awaitStep(
                draftStorage.beginUploadAttemptReset(
                  persistedSlot.draftSlotId ?? draftSlotId,
                  expectedOldKey,
                  replacementKey,
                ),
              );
              if (!began) return null;
              try {
                await awaitStep(
                  durableRecorder.resetUploadAttempt({
                    userId,
                    recordingId: slot.durable.recordingId,
                    expectedOldKey,
                    replacementKey,
                  }),
                );
              } catch (error) {
                // A native bridge may reject after the atomic manifest rename
                // already committed. Re-read the authoritative manifest before
                // compensating; blindly rolling back SecureStore here would
                // recreate the split-brain state this protocol prevents.
                const manifestAfterError = await awaitStep(
                  durableRecorder
                    .getManifest({ userId, recordingId: slot.durable.recordingId })
                    .catch(() => null),
                );
                const reconciliation = manifestAfterError
                  ? await awaitStep(
                      draftStorage
                        .reconcileUploadAttemptReset(
                          persistedSlot.draftSlotId ?? draftSlotId,
                          manifestAfterError.uploadKeyOverride,
                          manifestAfterError.supersededUploadKey,
                        )
                        .catch(() => 'blocked' as const),
                    )
                  : 'blocked';
                if (reconciliation !== 'committed') throw error;
                captureMessage('upload_restart_native_response_lost_after_commit', 'warning', {
                  tags: { phase: 'upload_recovery', mode: 'durable' },
                });
                draftReset = true;
              }
              // The native manifest is the durable commit point. If SecureStore
              // finalization fails, the phase-1 marker continues blocking every
              // background create and the next explicit callback/load reconciles.
              if (!draftReset) {
                draftReset = await awaitStep(
                  draftStorage
                    .commitUploadAttemptReset(
                      persistedSlot.draftSlotId ?? draftSlotId,
                      expectedOldKey,
                      replacementKey,
                    )
                    .catch(() => false),
                );
              }
              if (!draftReset) {
                captureMessage('upload_restart_draft_finalize_deferred', 'warning', {
                  tags: { phase: 'upload_recovery', mode: 'durable' },
                });
                draftReset = true;
              }
            } else if (!slot.durable.recoveredAudioUri) {
              captureMessage('upload_restart_native_manifest_unavailable', 'warning', {
                tags: { phase: 'upload_recovery', mode: 'durable' },
              });
              return null;
            }
          }

          if (!draftReset) {
            draftReset = await awaitStep(
              draftStorage.resetUploadAttempt(
                persistedSlot.draftSlotId ?? draftSlotId,
                expectedOldKey,
                replacementKey,
              ),
            );
          }
          if (!draftReset) {
            captureMessage('upload_restart_local_reset_failed', 'warning', {
              tags: { phase: 'upload_recovery', mode: slot.durable ? 'durable' : 'standard' },
            });
            return null;
          }

          if (!scopeIsCurrent()) return null;
          const restarted: PatientSlot = {
            ...persistedSlot,
            uploadKeyOverride: replacementKey,
            supersededUploadKey: expectedOldKey,
            uploadRecovery: null,
            metadataDivergence: null,
            uploadStatus: 'pending',
            uploadProgress: 0,
            uploadError: null,
            serverRecordingId: null,
            serverDraftId: null,
            pendingConfirm: null,
            draftMetadataDirty: false,
          };
          dispatch({
            type: 'RESET_UPLOAD_ATTEMPT',
            slotId: slot.id,
            uploadKeyOverride: replacementKey,
            supersededUploadKey: expectedOldKey,
          });
          trackEvent({
            name: 'upload_stale_recording_recovery',
            props: {
              stage: 'controlled_restart',
              outcome: 'local_state_preserved',
              attempt: 1,
              segment_count: slot.durable ? 1 : slot.segments.length,
              mode: slot.durable ? 'durable' : 'standard',
            },
          });
          return restarted;
        })();

        const timeoutResult = new Promise<null>((resolve) => {
          watchdog = setTimeout(() => {
            timedOut = true;
            captureMessage('upload_restart_local_watchdog_fired', 'warning', {
              tags: { phase: 'upload_recovery', mode: slot.durable ? 'durable' : 'standard' },
            });
            resolve(null);
          }, UPLOAD_RESTART_LOCAL_TIMEOUT_MS);
        });
        const result = await Promise.race([transaction, timeoutResult]);
        if (timedOut) {
          // Promise.race cannot cancel SecureStore or a native bridge call.
          // Keep the coordination guard until the underlying transaction
          // settles so its late CAS/write cannot overlap another submit,
          // background sync, edit, or delete.
          transaction.then(
            () => clearUploadRestart(slot.id),
            () => clearUploadRestart(slot.id),
          );
        }
        return result;
      } finally {
        if (watchdog) clearTimeout(watchdog);
        if (!timedOut) {
          clearUploadRestart(slot.id);
        }
      }
    },
    [cancelScheduledDraft, clearUploadRestart, dispatch, flushLocalDraftSave, markUploadRestart, user?.id],
  );

  const runSingleSubmit = useCallback(
    (slot: PatientSlot) => {
      const slotId = slot.id;
      markSubmitIntent([slotId]);
      setSubmittingSlotId(slotId);
      setBatchSlotIds([slotId]);

      (async () => {
        try {
          const serverRecordingId = await uploadSlot(slot);
          if (serverRecordingId) {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
            invalidateRecordingCaches(queryClient, 'submit_success');

            // Check if other slots still have unsaved recordings (exclude already-uploaded slots)
            const otherSlotsWithRecordings = sessionRef.current.slots.some(
              (s) => s.id !== slotId && s.uploadStatus !== 'success' &&
                (slotHasRecoverableAudio(s) || s.audioState === 'recording' || s.audioState === 'paused')
            );
            // An unresolved divergence is the whole point of holding the local
            // copy back. Resetting and navigating away here would discard the
            // reconcile card before the vet ever sees it, and the retained
            // draft would reappear later with no explanation of why.
            // Every tier that can reach here now carries an action — identity
            // has the three reconciliation choices, processing/descriptive have
            // "Got it" — so blocking on any of them cannot strand the vet, and
            // NOT blocking would navigate away before the notice is read.
            const hasUnresolvedDivergence = sessionRef.current.slots.some(
              (s) => s.metadataDivergence !== null
            );

            const completeSingleSubmit = () => {
              releaseResumedStashIfAny();
              resetSession();
              // from=submit: the detail screen's Back must return to the
              // recordings list, not router.back() into this just-reset form
              // (Codex P2, PR #143).
              router.push(`/recordings/${serverRecordingId}?from=submit` as `/recordings/${string}`);
            };
            if (otherSlotsWithRecordings || hasUnresolvedDivergence) {
              // Stay on the record screen — uploaded slot already shows success badge.
              // Do NOT release the pinned stash here: remaining slots may still be
              // reading audio files from the stash directory. Release runs only
              // after the whole session is resolved.
              //
              // Hand the deferred transition to the reconcile actions, but only
              // when a notice is the ONLY thing holding us here: with other
              // slots still unfinished the session must stay regardless, and
              // resuming later would reset it out from under them.
              deferredSuccessTransitionRef.current =
                hasUnresolvedDivergence && !otherSlotsWithRecordings
                  ? completeSingleSubmit
                  : null;
            } else {
              completeSingleSubmit();
            }
          } else {
            // Upload returned null — uploadSlot already set the on-card error
            // state and Sentry. If the failure was a transient r2_put network
            // death (RN-4 fingerprint), salvage the work into a stash instead
            // of leaving the user with an unactionable error badge.
            recordSelectedSlotUploadNull(slotId, 'single');
            await tryAutoStashOnNetworkDeath([slotId]);
          }
        } finally {
          clearSubmitIntent([slotId]);
          setSubmittingSlotId(null);
          setBatchSlotIds([]);
        }
      })().catch(() => {
        clearSubmitIntent([slotId]);
        setSubmittingSlotId(null);
        setBatchSlotIds([]);
      });
    },
    [clearSubmitIntent, markSubmitIntent, recordSelectedSlotUploadNull, uploadSlot, queryClient, resetSession, router, releaseResumedStashIfAny, tryAutoStashOnNetworkDeath]
  );

  // --- Metadata-divergence reconcile actions ------------------------------
  // All three are explicit, bounded, and never automatic. Un-sent local work is
  // only ever removed by a confirmed user action (CLAUDE.md rules 8 and 13).

  const handleOpenDivergentRecording = useCallback(
    (slotId: string) => {
      const slot = sessionRef.current.slots.find((candidate) => candidate.id === slotId);
      const recordingId =
        slot?.metadataDivergence?.recordingId || slot?.serverRecordingId || slot?.serverDraftId;
      if (!recordingId) return;
      router.push(`/(app)/(tabs)/recordings/${recordingId}`);
    },
    [router]
  );

  /** Claim the reconciliation lock for a slot, or refuse if one is running. */
  const claimReconcileLock = useCallback((slotId: string): boolean => {
    if (
      reconcilingSlotIdRef.current !== null ||
      submitIntentSlotIdsRef.current.has(slotId) ||
      uploadRestartSlotIdsRef.current.has(slotId)
    ) {
      return false;
    }
    reconcilingSlotIdRef.current = slotId;
    setReconcilingSlotId(slotId);
    return true;
  }, []);

  const releaseReconcileLock = useCallback(() => {
    reconcilingSlotIdRef.current = null;
    setReconcilingSlotId(null);
  }, []);

  /**
   * Run the reset+navigate a completed submit deferred while a notice still
   * needed reading — but only once the LAST one is resolved. Clearing the field
   * alone would leave the vet sitting on a finished session, having to navigate
   * out by hand.
   */
  const runDeferredSuccessTransition = useCallback((resolvedSlotId: string) => {
    const stillBlocked = sessionRef.current.slots.some(
      (s) => s.id !== resolvedSlotId && s.metadataDivergence !== null
    );
    if (stillBlocked) return;
    // Re-derive the OTHER half of the original decision too. The submit only
    // deferred this because nothing else was unfinished, but the vet can add a
    // patient and record while the notice sits there — and the closure ends in
    // resetSession(), which would silently discard that new audio. Drop the
    // closure instead of running it; the new work keeps the session, which is
    // what the submit would have done had that slot existed at the time.
    const othersUnfinished = sessionRef.current.slots.some(
      (s) =>
        s.id !== resolvedSlotId &&
        s.uploadStatus !== 'success' &&
        (slotHasRecoverableAudio(s) || s.audioState === 'recording' || s.audioState === 'paused')
    );
    if (othersUnfinished) {
      deferredSuccessTransitionRef.current = null;
      return;
    }
    const resume = deferredSuccessTransitionRef.current;
    deferredSuccessTransitionRef.current = null;
    resume?.();
  }, []);

  const handleReleaseLocalCopy = useCallback(
    (slotId: string) => {
      const slot = sessionRef.current.slots.find((candidate) => candidate.id === slotId);
      if (!slot) return;
      Alert.alert(
        METADATA_DIVERGENCE_COPY.releaseLocalCopyConfirmTitle,
        METADATA_DIVERGENCE_COPY.releaseLocalCopyConfirmBody,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: METADATA_DIVERGENCE_COPY.releaseLocalCopyConfirm,
            style: 'destructive',
            onPress: () => {
              // The server copy is already proven durable (committed keys with
              // a passing R2 HEAD), so releasing the local copy is safe. Only a
              // human can decide it is the same visit, which is what this is.
              //
              // Ordering is load-bearing and mirrors the durable success path:
              // verify the draft is actually gone BEFORE purging audio, and
              // persist the tombstone before clearing the card. deleteDraft
              // swallows its own storage failures, so a try/catch cannot tell
              // whether the metadata was removed — only a read-back can. Get
              // this wrong and a stale draft survives with its audio and its
              // uploaded-manifest evidence destroyed, which is exactly the
              // state an orphan sweep resolves by deleting the server row the
              // user just chose to keep.
              if (!claimReconcileLock(slot.id)) return;
              const releaseGeneration = ++reconcileGenerationRef.current;
              let releaseWatchdog: ReturnType<typeof setTimeout> | null = null;
              // Set for exactly as long as a non-cancellable native purge is
              // outstanding; the watchdog refuses to free the slot while it is.
              let purgeInFlight = false;
              void (async () => {
                const durable = slot.durable;
                const userId = user?.id;
                const recordingId =
                  slot.metadataDivergence?.recordingId ||
                  slot.serverRecordingId ||
                  slot.serverDraftId ||
                  null;

                // draftStorage and the tombstone both key off the CURRENT user.
                // If the account changes while deleteDraft awaits SecureStore,
                // the strict read would prove absence in the REPLACEMENT user's
                // namespace and the tombstone would land there, after which the
                // purge destroys this user's manifest and leaves the confirmed
                // row unguarded. Bind the whole transaction to the scope it
                // started in, as the separate-submission path does.
                const initiatingScopeKey = authScopeKeyRef.current;
                const initiatingScopeGeneration = authScopeGenerationRef.current;
                // Rule 24: the same abandonment check the conversion uses. Every
                // step below awaits SecureStore or a native bridge, and both can
                // HANG rather than reject — so without this the whole task never
                // settles, its trailing finally never runs, and this slot stays
                // mutation-locked with every reconciliation action disabled
                // until the app is restarted.
                const scopeIsCurrent = () =>
                  reconcileGenerationRef.current === releaseGeneration &&
                  authScopeMountedRef.current &&
                  initiatingScopeKey !== null &&
                  userId !== undefined &&
                  authScopeKeyRef.current === initiatingScopeKey &&
                  authScopeGenerationRef.current === initiatingScopeGeneration &&
                  draftStorage.getUserId() === userId;
                const reportCleanupFailed = () => {
                  Alert.alert(
                    METADATA_DIVERGENCE_COPY.releaseLocalCopyFailedTitle,
                    METADATA_DIVERGENCE_COPY.releaseLocalCopyFailedBody
                  );
                };
                if (!scopeIsCurrent()) {
                  reportCleanupFailed();
                  return;
                }

                // The key that OWNS the persisted draft, not the slot's own id.
                // A slot restored from a stash carries a draftSlotId that does
                // not equal `slot.id` (see stashResumedSlotIdsRef), and deleting
                // `slot.id` there removes nothing while the strict check then
                // PROVES that never-written key missing — `draftDeleted` turns
                // true and the transaction purges the manifest and segments out
                // from under a draft that still exists and still points at them.
                // The hold release below already uses this key; one function
                // must not address the same draft two ways.
                const ownedDraftSlotId = slot.draftSlotId ?? slot.id;
                const confirmDraftGone = async (): Promise<boolean> => {
                  try {
                    await draftStorage.deleteDraft(ownedDraftSlotId);
                    await recoveryIntent.clearForDraftSlot(ownedDraftSlotId);
                  } catch {
                    return false;
                  }
                  // getDraft is LENIENT: an unreadable Keystore also yields null,
                // which would read as proof of deletion and license the purge
                // below. Only PROVEN absence counts.
                return (
                  (await draftStorage
                    .draftMetadataExistsStrict(ownedDraftSlotId)
                    .catch(() => 'unknown' as const)) === 'missing'
                );
                };
                let draftDeleted = await confirmDraftGone();
                if (!draftDeleted) draftDeleted = await confirmDraftGone();
                if (!scopeIsCurrent()) {
                  reportCleanupFailed();
                  return;
                }

                if (durable && userId) {
                  // Tombstone FIRST: it is what stops an offline self-heal from
                  // deleting the server row, and it must outlive a purge that
                  // succeeds while the draft delete did not. add() reports a
                  // failed write by RESOLVING false, not by rejecting, so a
                  // .catch() alone would purge without the guard in place — and
                  // an identity-copy autosave racing behind us could recreate
                  // the draft with neither manifest nor tombstone left, which is
                  // how orphan cleanup reaches a confirmed server row.
                  const tombstoned = await durableTombstone
                    .add(durable.recordingId)
                    .catch(() => false);
                  if (!tombstoned || !scopeIsCurrent()) {
                    reportCleanupFailed();
                    return;
                  }
                  if (draftDeleted) {
                    purgeInFlight = true;
                    try {
                      await durableRecorder
                        .purgeAfterUpload({ userId, recordingId: durable.recordingId })
                        .catch(() => {});
                    } finally {
                      purgeInFlight = false;
                    }
                    if (durable.recoveredAudioUri) safeDeleteFile(durable.recoveredAudioUri);
                    // Only now: the hold is what keeps recovery off this
                    // recording, so it must outlive every step it protects.
                    // Releasing it before a failed delete would expose the copy
                    // to the next scan instead of leaving it retained.
                    await releaseReconcileHold(durable.recordingId, 'release_durable');
                  }
                  durableRecoveryStore.remove(durable.recordingId);
                } else if (draftDeleted) {
                  slot.segments.forEach((seg) => {
                    safeDeleteFile(seg.uri);
                  });
                  // Standard holds are keyed by draft slot id (no durable id).
                  await releaseReconcileHold(slot.draftSlotId ?? slot.id, 'release_standard');
                }

                // Only a PROVEN delete may report the copy as removed. If the
                // store stayed unreadable, saying "done" and clearing the card
                // would leave a stale draft with no way back to the actions —
                // and it can reappear later and rediscover the same conflict.
                // Leave the card actionable and say what happened instead.
                if (!draftDeleted || !scopeIsCurrent()) {
                  reportCleanupFailed();
                  return;
                }
                // Leave the slot resolved, not stuck. Without this the card's
                // parent slot keeps uploadStatus 'error' from the adopt-path
                // throw, still offers Retry Upload against files we just
                // deleted, and still reads as unsaved work to the nav guard.
                dispatch({ type: 'REPLACE_ALL_SEGMENTS', slotId: slot.id, segments: [] });
                setUploadStatus(slot.id, 'success', {
                  progress: 100,
                  error: null,
                  ...(recordingId ? { serverRecordingId: recordingId } : {}),
                });
                dispatch({
                  type: 'SET_METADATA_DIVERGENCE',
                  slotId: slot.id,
                  divergence: null,
                });
                runDeferredSuccessTransition(slot.id);
              })()
                // .finally() PRESERVES a rejection, and this task is
                // fire-and-forget from an Alert callback — so anything throwing
                // outside the individually-handled calls becomes an unhandled
                // rejection, which Hermes turns into a release-build crash
                // (rule 4). The finalizers below still run either way.
                .catch(() => {})
                .finally(() => {
                  // Only if this task still OWNS the lock. The watchdog may have
                  // released it already and another slot may have claimed it —
                  // releasing again would re-enable mutations underneath a newer
                  // transaction that is mid-delete.
                  if (
                    reconcilingSlotIdRef.current === slot.id &&
                    reconcileGenerationRef.current === releaseGeneration
                  ) {
                    releaseReconcileLock();
                  }
                })
                // Settled in time: cancel the watchdog, or it fires at the
                // deadline anyway — emitting a false warning, bumping the
                // generation, and telling the vet cleanup failed after the copy
                // was already removed and the screen navigated away.
                .finally(() => {
                  if (releaseWatchdog) clearTimeout(releaseWatchdog);
                });
              // The task above can HANG (SecureStore, Keystore, a native purge),
              // and a promise that never settles never reaches that finally —
              // leaving this slot mutation-locked and every reconciliation
              // action disabled until the app restarts. Bound it: bumping the
              // generation makes each remaining step a no-op (scopeIsCurrent
              // reads it), so releasing the gate is safe rather than a licence
              // for late destructive work.
              releaseWatchdog = setTimeout(() => {
                if (reconcileGenerationRef.current !== releaseGeneration) return;
                reconcileGenerationRef.current += 1;
                captureMessage('release_local_copy_watchdog_fired', 'warning', {
                  tags: { phase: 'upload_recovery', purge_in_flight: String(purgeInFlight) },
                });
                // A generation bump stops the remaining STEPS; it cannot recall a
                // native purge that has already started. Freeing the slot then
                // would let "Submit separately" begin copying from a manifest
                // the old purge is about to delete — so while that call is
                // outstanding the slot stays locked and the task's own finally
                // is what releases it.
                if (!purgeInFlight && reconcilingSlotIdRef.current === slot.id) {
                  releaseReconcileLock();
                }
                Alert.alert(
                  METADATA_DIVERGENCE_COPY.releaseLocalCopyFailedTitle,
                  METADATA_DIVERGENCE_COPY.releaseLocalCopyFailedBody
                );
              }, RECONCILE_TRANSACTION_TIMEOUT_MS);
            },
          },
        ]
      );
    },
    [
      claimReconcileLock,
      dispatch,
      releaseReconcileLock,
      runDeferredSuccessTransition,
      setUploadStatus,
      user?.id,
      releaseReconcileHold,
    ]
  );

  /**
   * "Not this visit — submit separately" for a durable capture whose manifest is
   * ALREADY confirmed-uploaded.
   *
   * The commit path calls `markUploaded()` before holding the local copy back
   * (it is what stops launch recovery re-offering an uploaded capture), so by
   * the time this card appears the manifest is in state `uploaded`. Both native
   * engines reject `resetUploadAttempt` in that state — "confirmed upload
   * cannot be restarted" (DurableRecorderEngine.kt / .swift) — so routing this
   * action straight into `persistControlledUploadRestart` made it a silent
   * no-op: the promised separate submission never happened.
   *
   * A confirmed manifest cannot be rotated, so lift the bytes out instead. The
   * result is the shape the submit path already supports for a vault restore:
   * a slot whose `durable.recoveredAudioUri` is a plain local .aac with no
   * native manifest behind it. The standard restart transaction then runs on
   * that shape and only touches SecureStore.
   *
   * Ordering is load-bearing and mirrors the release path: nothing destructive
   * happens until a NON-EMPTY copy is verified on disk, and the tombstone is
   * written before the purge so an offline self-heal can never delete the
   * server row this recording legitimately confirmed to.
   */
  const persistPostConfirmSeparateSubmission = useCallback(
    async (
      slot: PatientSlot,
      isAbandoned: () => boolean = () => false,
    ): Promise<PatientSlot | null> => {
      const durable = slot.durable;
      const userId = user?.id;
      // No durable manifest to be blocked by: the standard restart already works.
      if (!durable || !userId || durable.recoveredAudioUri) return null;

      // Every write below is user-scoped (draftStorage and the tombstone both
      // key off the CURRENT user), and the caller only rechecks scope after
      // this helper returns. A sign-out plus another sign-in while the copy is
      // in flight would otherwise persist this user's slot and audio URI into
      // the next user's namespace on a shared tablet.
      const initiatingScopeKey = authScopeKeyRef.current;
      const initiatingScopeGeneration = authScopeGenerationRef.current;
      // Abandonment rides along with scope: once the caller has stopped waiting,
      // a late step must not mutate storage it no longer coordinates with.
      const scopeIsCurrent = () =>
        !isAbandoned() &&
        authScopeMountedRef.current &&
        initiatingScopeKey !== null &&
        authScopeKeyRef.current === initiatingScopeKey &&
        authScopeGenerationRef.current === initiatingScopeGeneration &&
        draftStorage.getUserId() === userId;
      if (!scopeIsCurrent()) return null;

      const manifest = await durableRecorder
        .getManifest({ userId, recordingId: durable.recordingId })
        .catch(() => null);
      if (!scopeIsCurrent()) return null;
      if (!manifest) return null;
      const confirmed = manifest.state === 'uploaded' || !!manifest.confirmedUploadAt;
      if (!confirmed) return null;
      const sourceUri = manifest.audioFile?.uri;
      if (!sourceUri) return null;

      // Copy the COMPLETE-FRAME PREFIX, not the raw file. A crash-recovered
      // audio.aac can end in a torn partial ADTS frame; the ordinary upload
      // truncates at `completeFrameBytes` for exactly that reason, but the
      // recovered-copy path explicitly skips that truncation — so copying the
      // whole file here would ship the malformed tail, and this transaction
      // then purges the manifest that carries the frame boundary needed to
      // repair it.
      const completeBytes = manifest.audioFile?.completeFrameBytes ?? 0;
      if (!(completeBytes > 0)) return null;
      const dir = `${Paths.document.uri}${RECOVERED_DURABLE_DIR_NAME}/${userId}/`;
      if (!ensureDirectory(dir)) return null;
      const copyUri = `${dir}${durable.recordingId}-separate.aac`;
      if (!writeFilePrefix(sourceUri, copyUri, completeBytes)) {
        safeDeleteFile(copyUri);
        return null;
      }
      const info = await getInfoAsync(copyUri).catch(() => null);
      if (!info?.exists || info.size !== completeBytes) {
        safeDeleteFile(copyUri);
        return null;
      }
      // The copy lives under the INITIATING user's directory, so if the account
      // changed while it was being written it is this user's file to remove and
      // nothing may be persisted under the new one.
      if (!scopeIsCurrent()) {
        safeDeleteFile(copyUri);
        return null;
      }

      // A DISTINCT durable identity for the replacement. The original id is
      // about to be tombstoned, and a tombstone means "already submitted":
      // loadDraft refuses to resume that draft and deletes it, and
      // cleanupOrphaned sweeps it — which would destroy the separate
      // submission the vet just asked for. The loose copy has no native
      // manifest behind it, so the id is only a label; give it a fresh one.
      const looseDurable = {
        ...durable,
        recordingId: newDurableRecordingId(),
        recoveredAudioUri: copyUri,
      };
      // Drop the DISPUTED server anchor in the same object that is about to be
      // persisted. This draft becomes crash-recoverable the instant saveDraft
      // lands, but the restart that clears the anchor runs much later — after
      // the tombstone, the hold release and the purge. Die in that window and
      // the recovered draft carries the NEW durable id (so the hold, keyed by
      // the ORIGINAL id, is not found and no conflict card opens) while still
      // naming the disputed `serverDraftId` — and its next ordinary submit
      // passes that as `existingRecordingId`, promoting the very row the vet
      // chose to submit SEPARATELY from. Clearing it here makes the worst case
      // a new recording, which is what they asked for.
      //
      // The upload KEY is deliberately left alone: persistControlledUploadRestart
      // rotates it under a begin/commit protocol and derives `expectedOldKey`
      // from this slot, so rotating it early would make that comparison fail.
      const converted: PatientSlot = {
        ...slot,
        durable: looseDurable,
        serverDraftId: null,
        serverRecordingId: null,
        pendingConfirm: null,
      };

      // PERSIST THE POINTER BEFORE PURGING. The purge is the point of no
      // return, and everything that records where the audio went happens after
      // it — the dispatch, and the draft write inside the restart transaction.
      // Die in that window and the stored draft still points at a manifest that
      // no longer exists while the copy sits unreferenced on disk: audio the
      // vet can no longer reach. So write the draft first and read it back;
      // saveDraft is metadata-only for a durable slot, so this is cheap.
      let persistedDraftSlotId: string | null = null;
      try {
        const saved = await draftStorage.saveDraft(converted);
        persistedDraftSlotId = saved.draftSlotId;
      } catch {
        safeDeleteFile(copyUri);
        return null;
      }
      if (!scopeIsCurrent()) return null;
      const readBack = await draftStorage.getDraft(persistedDraftSlotId).catch(() => null);
      if (readBack?.durable?.recoveredAudioUri !== copyUri) {
        // KEEP the copy here, unlike the throw above. The write may have landed
        // and only the read failed, in which case a stored draft now points at
        // copyUri; deleting it would turn an unreferenced file into a dangling
        // pointer. Nothing was purged, so the native manifest is still the
        // preferred source either way and the stray file is at worst wasted
        // disk that the draft's own deletion reclaims.
        return null;
      }

      // The tombstone is REQUIRED, not best-effort: it is the only thing that
      // stops a later orphan sweep from deleting the server row this recording
      // legitimately confirmed to. add() returns false when the write did not
      // land, so a failure means keeping the native manifest — which is
      // recoverable — rather than purging without the guard.
      if (!scopeIsCurrent()) return null;
      const tombstoned = await durableTombstone.add(durable.recordingId).catch(() => false);
      if (!tombstoned || !scopeIsCurrent()) return null;
      // The replacement carries a fresh durable id and its own draft, so the
      // original's hold has nothing left to protect — and leaving it would
      // permanently suppress a manifest we are about to purge.
      await releaseReconcileHold(durable.recordingId, 'resubmit_as_new_durable');
      await releaseReconcileHold(slot.draftSlotId ?? slot.id, 'resubmit_as_new_standard');

      // Last check before the point of no return. The timeout can fire while
      // either removal above is awaiting storage, after which the gates are
      // released and a retry may already be copying to the SAME loose-copy URI
      // — so an abandoned transaction that walked straight into the purge could
      // destroy the source under it, and a failed retry would then delete the
      // shared destination too, leaving the draft with no audio at all.
      if (!scopeIsCurrent()) return null;
      await durableRecorder
        .purgeAfterUpload({ userId, recordingId: durable.recordingId })
        .catch(() => {});
      durableRecoveryStore.remove(durable.recordingId);

      if (!scopeIsCurrent()) return null;
      dispatch({ type: 'SET_DURABLE_RECORDING', slotId: slot.id, durable: looseDurable });
      if (persistedDraftSlotId && persistedDraftSlotId !== slot.draftSlotId) {
        dispatch({
          type: 'SET_DRAFT_IDS',
          slotId: slot.id,
          draftSlotId: persistedDraftSlotId,
          serverDraftId: slot.serverDraftId,
          preserveDirty: true,
        });
      }
      return { ...converted, draftSlotId: persistedDraftSlotId ?? slot.draftSlotId };
    },
    [dispatch, user?.id, releaseReconcileHold]
  );

  /**
   * "Got it" on a processing/descriptive notice. Those tiers hold nothing back
   * and offer no repair here — the values are editable on the recording — so
   * acknowledging them is the whole action. It is also what releases the submit
   * guard, which deliberately keeps the session mounted until then so the
   * notice cannot flash past unread on the way to the next screen.
   */
  const handleDismissDivergence = useCallback(
    (slotId: string) => {
      const slot = sessionRef.current.slots.find((candidate) => candidate.id === slotId);
      dispatch({ type: 'SET_METADATA_DIVERGENCE', slotId, divergence: null });
      // An acknowledged notice is a resolved conflict: drop any persisted hold
      // so the recording stops being suppressed from recovery forever.
      const durableId = slot?.durable?.recordingId;
      if (durableId) void releaseReconcileHold(durableId, 'dismiss_durable');
      const standardKey = slot?.draftSlotId ?? slot?.id;
      if (standardKey) void releaseReconcileHold(standardKey, 'dismiss_standard');
      runDeferredSuccessTransition(slotId);
    },
    [dispatch, runDeferredSuccessTransition, releaseReconcileHold]
  );

  const handleResubmitAsNew = useCallback(
    (slotId: string) => {
      const slot = sessionRef.current.slots.find((candidate) => candidate.id === slotId);
      if (!slot) return;
      Alert.alert(
        METADATA_DIVERGENCE_COPY.resubmitAsNewConfirmTitle,
        METADATA_DIVERGENCE_COPY.resubmitAsNewConfirmBody,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: METADATA_DIVERGENCE_COPY.resubmitAsNewConfirm,
            onPress: () => {
              // Rotates the upload intent so the server creates a separate row,
              // and preserves the local audio throughout. A durable capture
              // whose manifest is already confirmed-uploaded cannot be rotated
              // at all, so it is converted to a loose local copy first — see
              // persistPostConfirmSeparateSubmission.
              const initiatingScopeKey = authScopeKeyRef.current;
              const initiatingScopeGeneration = authScopeGenerationRef.current;
              const initiatingUserId = user?.id;
              const scopeIsCurrent = () =>
                authScopeMountedRef.current &&
                initiatingScopeKey !== null &&
                initiatingUserId !== undefined &&
                authScopeKeyRef.current === initiatingScopeKey &&
                authScopeGenerationRef.current === initiatingScopeGeneration &&
                draftStorage.getUserId() === initiatingUserId;
              if (!claimReconcileLock(slot.id)) return;
              markSubmitIntent([slot.id]);
              const generation = ++reconcileGenerationRef.current;
              void (async () => {
                // Rule 24: bound it. A hung native bridge here never rejects,
                // so the .catch() would never run, the restart watchdog would
                // never be reached, and clearSubmitIntent would never fire —
                // leaving the whole Record UI frozen. On timeout the original
                // manifest and the copied audio both remain recoverable.
                const conversion = persistPostConfirmSeparateSubmission(
                  slot,
                  () => reconcileGenerationRef.current !== generation,
                );
                let timedOut = false;
                const converted = await withPromiseTimeout(
                  conversion,
                  POST_CONFIRM_CONVERSION_TIMEOUT_MS,
                  'post_confirm_separate_submission'
                ).catch(() => {
                  timedOut = true;
                  return null;
                });
                if (timedOut) {
                  // The timeout recovered the UI; it did NOT cancel the
                  // conversion. Restarting the ORIGINAL slot now would race a
                  // conversion that may already have persisted the loose-copy
                  // pointer — overwriting it with the original durable pointer,
                  // which the late conversion then purges. So ABANDON it
                  // instead: bumping the generation makes every remaining step
                  // a no-op before it can touch storage, and that is what makes
                  // releasing the gate now safe. Waiting for a call that may
                  // never settle left "Try again" pointing at controls that
                  // stayed inert until the app was restarted.
                  reconcileGenerationRef.current += 1;
                  // Free the SUBMIT intent so the rest of the session is usable
                  // again — but keep this slot's reconciliation lock until the
                  // conversion actually settles. The generation bump stops every
                  // remaining STEP, and it cannot stop the `saveDraft()` already
                  // in flight: if a retry were allowed to start now it could
                  // persist the replacement upload key only for that older write
                  // to land afterwards and overwrite the draft with the original
                  // confirmed identity — after which "submit separately" adopts
                  // the old row again on the next launch. Awaiting here keeps the
                  // slot frozen (isSlotUploadActive consults the same ref) while
                  // leaving everything else responsive.
                  clearSubmitIntent([slot.id]);
                  Alert.alert(
                    METADATA_DIVERGENCE_COPY.resubmitStillFinishingTitle,
                    METADATA_DIVERGENCE_COPY.resubmitStillFinishingBody
                  );
                  await conversion.catch(() => {});
                  return;
                }
                const restarted = await persistControlledUploadRestart(converted ?? slot).catch(
                  () => null
                );
                if (!scopeIsCurrent()) {
                  clearSubmitIntent([slot.id]);
                  return;
                }
                if (!restarted) {
                  // Never fail silently here: the vet asked for a second
                  // recording and the local copy is still the only one they
                  // control. Saying nothing reads as "done".
                  clearSubmitIntent([slot.id]);
                  Alert.alert(
                    METADATA_DIVERGENCE_COPY.resubmitAsNewFailedTitle,
                    METADATA_DIVERGENCE_COPY.resubmitAsNewFailedBody
                  );
                  return;
                }
                // saveDraft(requireCompleteAudio) PROMOTED the segments to
                // versioned draft paths and deleted the previous snapshot
                // files, and RESET_UPLOAD_ATTEMPT does not carry segments — so
                // live state must take the returned snapshot or the next submit
                // preflights against URIs that no longer exist.
                if (!restarted.durable && restarted.segments.length > 0) {
                  dispatch({
                    type: 'REPLACE_ALL_SEGMENTS',
                    slotId: slot.id,
                    segments: restarted.segments,
                  });
                }
                // A STANDARD slot skips the conversion helper, and with it the
                // only place that drops the slot-key hold. The replacement
                // identity is durably persisted by the restart transaction that
                // just returned, so the old hold now protects nothing — and
                // leaving it there walks the bounded 50-entry list toward the
                // cap, after which a future conflict cannot persist its
                // protection at all.
                if (!converted) {
                  await releaseReconcileHold(slot.draftSlotId ?? slot.id, 'restart_standard');
                }
                // This submit will produce its own transition; drop the one the
                // previous submit deferred so it cannot fire against a session
                // that has moved on.
                deferredSuccessTransitionRef.current = null;
                // The confirmation promised a submission, so perform it rather
                // than leaving a pending slot the vet has to submit again.
                runSingleSubmit(restarted);
              })().finally(() => {
                // Same ownership rule as the release path: never hand the lock
                // back on behalf of a transaction that no longer holds it.
                if (
                  reconcilingSlotIdRef.current === slot.id &&
                  reconcileGenerationRef.current === generation
                ) {
                  releaseReconcileLock();
                }
              });
            },
          },
        ]
      );
    },
    [
      claimReconcileLock,
      clearSubmitIntent,
      dispatch,
      markSubmitIntent,
      releaseReconcileLock,
      persistControlledUploadRestart,
      persistPostConfirmSeparateSubmission,
      runSingleSubmit,
      user?.id,
      releaseReconcileHold,
    ]
  );

  const handleSubmitSingle = useCallback(
    (slotId: string) => {
      const slot = sessionRef.current.slots.find((candidate) => candidate.id === slotId);
      if (!slot) return;
      if (finishingDraftSlotId === slotId) {
        Alert.alert('Saving Recording', 'Please wait until the recording is saved before submitting.');
        return;
      }
      if (!canRecordAppointments(user?.role)) {
        showRecordPermissionAlert();
        return;
      }
      if (slotHasLiveRecorder(slot)) {
        Alert.alert(
          'Finish Recording First',
          'Finish or discard the active recording segment before submitting this patient.',
        );
        return;
      }
      if (!slot.uploadRecovery) {
        runSingleSubmit(slot);
        return;
      }
      if (!slot.uploadRecovery.canRestart) {
        runSingleSubmit(slot);
        return;
      }

      Alert.alert(
        'Restart Upload Safely?',
        'Captivet will preserve the recording on this device, create a new upload attempt, and leave the conflicted server attempt untouched.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Restart Upload',
            onPress: () => {
              const initiatingScopeKey = authScopeKeyRef.current;
              const initiatingScopeGeneration = authScopeGenerationRef.current;
              const initiatingUserId = user?.id;
              const scopeIsCurrent = () =>
                authScopeMountedRef.current &&
                initiatingScopeKey !== null &&
                initiatingUserId !== undefined &&
                authScopeKeyRef.current === initiatingScopeKey &&
                authScopeGenerationRef.current === initiatingScopeGeneration &&
                draftStorage.getUserId() === initiatingUserId;
              // Block any already-scheduled draft sync before the two-phase
              // local restart begins. runSingleSubmit keeps this marker set
              // until the recovery request finishes.
              markSubmitIntent([slot.id]);
              persistControlledUploadRestart(slot)
                .then((restarted) => {
                  if (!scopeIsCurrent()) {
                    clearSubmitIntent([slot.id]);
                    return;
                  }
                  if (restarted) {
                    runSingleSubmit(restarted);
                    return;
                  }
                  clearSubmitIntent([slot.id]);
                  Alert.alert(
                    'Restart Not Started',
                    'The local recovery state changed. Your audio is still saved; check the upload status again.',
                  );
                })
                .catch(() => {
                  if (!scopeIsCurrent()) {
                    clearSubmitIntent([slot.id]);
                    return;
                  }
                  clearSubmitIntent([slot.id]);
                  Alert.alert(
                    'Restart Not Started',
                    'Captivet could not safely save the new upload attempt. Your audio remains on this device.',
                  );
                });
            },
          },
        ],
      );
    },
    [
      clearSubmitIntent,
      finishingDraftSlotId,
      markSubmitIntent,
      persistControlledUploadRestart,
      runSingleSubmit,
      slotHasLiveRecorder,
      user?.id,
      user?.role,
    ],
  );

  /**
   * A slot holding a local copy for an unresolved identity divergence cannot be
   * stashed: `stashSession()` skips every succeeded slot, yet the stash's
   * cleanup deletes the local draft for EVERY slot in the session and then
   * resets it. The held audio would be destroyed — and for a durable capture
   * `markUploaded()` has already removed it from recovery, so nothing would be
   * left pointing at it. Fail closed the same way in-flight upload work does;
   * the three reconciliation actions are all quick.
   */
  const hasUnresolvedHeldCopy = useCallback(
    () =>
      sessionRef.current.slots.some(
        // Not just the succeeded ones. An ADOPT-path conflict leaves the slot in
        // 'error', and the stash payload does not carry metadataDivergence —
        // `useStashedSessions` restores it as null — so Save Session then Resume
        // silently strips all three reconciliation actions while the persisted
        // hold keeps protecting audio nothing can now resolve.
        (s) => s.metadataDivergence?.tier === 'identity',
      ),
    [],
  );

  const handleSubmitAll = useCallback(() => {
    if (!canRecordAppointments(user?.role)) {
      showRecordPermissionAlert();
      return;
    }
    if (finishingDraftSlotId) {
      Alert.alert(
        'Saving Recording',
        'Please wait until the recording is saved before submitting all patients.'
      );
      return;
    }
    if (sessionRef.current.slots.some(slotHasLiveRecorder)) {
      Alert.alert(
        'Finish Active Recordings',
        'Finish or discard all active recording segments before submitting all patients.'
      );
      return;
    }
    // An adopt-path conflict sits in uploadStatus 'error', so the batch would
    // otherwise pick it up as an ordinary retry — and uploadSlot() clears
    // metadataDivergence at the start, silently re-submitting the disputed
    // intent without the explicit choice the per-slot card insists on.
    if (hasUnresolvedHeldCopy()) {
      Alert.alert(
        METADATA_DIVERGENCE_COPY.submitAllBlockedTitle,
        METADATA_DIVERGENCE_COPY.submitAllBlockedBody
      );
      return;
    }

    const recordedSlotsNeedingDetails = recordFirstEnabled
      ? []
      : sessionRef.current.slots.filter(
          (s) =>
            slotHasRecoverableAudio(s) &&
            s.uploadStatus !== 'success' &&
            !slotHasRequiredSubmitFields(s)
        );
    if (recordedSlotsNeedingDetails.length > 0) {
      Alert.alert(
        'Add Required Details',
        `${recordedSlotsNeedingDetails.length} recorded patient${
          recordedSlotsNeedingDetails.length > 1 ? 's need' : ' needs'
        } required details before Submit All.`
      );
      return;
    }

    const slotsToUpload = sessionRef.current.slots.filter(
      (s) => slotHasRecoverableAudio(s) &&
        (recordFirstEnabled || slotHasRequiredSubmitFields(s)) &&
        s.uploadStatus !== 'success' &&
        s.uploadStatus !== 'uploading' &&
        !slotHasLiveRecorder(s)
    );

    if (slotsToUpload.length === 0) return;
    const conflictedSlot = slotsToUpload.find((slot) => slot.uploadRecovery?.canRestart);
    if (conflictedSlot) {
      const conflictedIndex = sessionRef.current.slots.findIndex(
        (slot) => slot.id === conflictedSlot.id,
      );
      if (conflictedIndex >= 0) setActiveIndex(conflictedIndex);
      Alert.alert(
        UPLOAD_RECOVERY_COPY.submitAllBlockedTitle,
        UPLOAD_RECOVERY_COPY.submitAllBlockedBody,
      );
      return;
    }

    const slotIdsToUpload = slotsToUpload.map((slot) => slot.id);
    markSubmitIntent(slotIdsToUpload);
    setIsSubmittingAll(true);
    setBatchSlotIds(slotIdsToUpload);
    trackEvent({ name: 'submit_all_attempted', props: { slot_count: slotsToUpload.length } });

    // Track NetInfo transitions only during the active upload loop. Each
    // transition becomes a Sentry breadcrumb so a failed upload carries
    // "was wifi → cellular → none → ..." in its issue context. We don't
    // leave the subscription open outside the upload window; steady-state
    // is tracked elsewhere.
    let lastNetType: string | null = null;
    const netUnsub = NetInfo.addEventListener((state: any) => {
      const nextType: string = state?.isConnected
        ? (state?.type === 'wifi' || state?.type === 'cellular' ? state.type : 'unknown')
        : 'none';
      if (lastNetType !== null && lastNetType !== nextType) {
        breadcrumb('network', 'state_change', {
          from: lastNetType,
          to: nextType,
          during: 'upload',
        });
      }
      lastNetType = nextType;
    });

    setSessionActivity('upload');

    (async () => {
      try {
        let allSuccess = true;
        const failedSlotIds: string[] = [];
        const submittedRecordingIds: string[] = [];
        // Sequential uploads to avoid network saturation
        for (const slot of slotsToUpload) {
          setSubmittingSlotId(slot.id);
          const recordingId = await uploadSlot(slot);
          if (!recordingId) {
            allSuccess = false;
            failedSlotIds.push(slot.id);
            recordSelectedSlotUploadNull(slot.id, 'all');
          } else {
            submittedRecordingIds.push(recordingId);
          }
        }

        trackEvent({
          name: 'submit_all_completed',
          props: {
            slot_count: slotsToUpload.length,
            success_count: submittedRecordingIds.length,
            failure_count: failedSlotIds.length,
          },
        });

        Haptics.notificationAsync(
          allSuccess
            ? Haptics.NotificationFeedbackType.Success
            : Haptics.NotificationFeedbackType.Warning
        ).catch(() => {});

        invalidateRecordingCaches(queryClient, 'submit_success');

        // Same reason as runSingleSubmit: an unresolved divergence means a local
        // copy is being held back on purpose, and resetting would discard the
        // card explaining why before it is ever seen.
        // Same rule as runSingleSubmit: every reachable tier has an action, so
        // holding the session open until one is taken is safe and is the only
        // way the notice is seen at all.
        const hasUnresolvedDivergence = sessionRef.current.slots.some(
          (s) => s.metadataDivergence !== null
        );

        const completeSubmitAll = () => {
          releaseResumedStashIfAny();
          resetSession();
          router.push({
            pathname: '/recordings',
            params: { submittedIds: submittedRecordingIds.join(',') },
          } as never);
        };
        if (allSuccess && hasUnresolvedDivergence) {
          // Every upload succeeded; the session stays put so the reconcile card
          // is reachable. Nothing failed, so no failure alert and no auto-stash.
          // Acknowledging the last notice runs the navigation deferred here.
          deferredSuccessTransitionRef.current = completeSubmitAll;
        } else if (allSuccess) {
          completeSubmitAll();
        } else {
          // If every failure was a transient r2_put exhaustion (network died
          // during sequential upload), auto-stash the failed slots instead of
          // making the user manually tap each one. tryAutoStash returns true
          // only when at least one slot was eligible AND the stash committed —
          // otherwise fall through to the generic retry-each alert.
          const stashed = await tryAutoStashOnNetworkDeath(failedSlotIds);
          if (!stashed) {
            Alert.alert(
              'Some Uploads Failed',
              'Some recordings failed to upload. You can retry the failed ones.'
            );
          }
        }
      } finally {
        clearSubmitIntent(slotIdsToUpload);
        setIsSubmittingAll(false);
        setSubmittingSlotId(null);
        setBatchSlotIds([]);
        try { netUnsub(); } catch { /* noop */ }
        setSessionActivity('idle');
      }
    })().catch(() => {
      clearSubmitIntent(slotIdsToUpload);
      setIsSubmittingAll(false);
      setSubmittingSlotId(null);
      setBatchSlotIds([]);
      try { netUnsub(); } catch { /* noop */ }
      setSessionActivity('idle');
    });
  }, [clearSubmitIntent, finishingDraftSlotId, hasUnresolvedHeldCopy, markSubmitIntent, recordFirstEnabled, recordSelectedSlotUploadNull, setActiveIndex, slotHasLiveRecorder, uploadSlot, queryClient, router, resetSession, releaseResumedStashIfAny, tryAutoStashOnNetworkDeath, user?.role]);

  const handleAddPatient = useCallback(() => {
    // Frozen during Submit All — a new patient created mid-batch would be wiped
    // by the post-batch resetSession() (Codex P1, PR #143).
    if (isSubmittingAllRef.current) {
      showUploadInProgressAlert();
      return;
    }
    const shouldWarnRecordFirstMultiPatient =
      recordFirstEnabled &&
      sessionRef.current.slots.length === 1 &&
      !multiPatientRecordFirstWarningShownRef.current;

    addSlot();
    if (shouldWarnRecordFirstMultiPatient) {
      multiPatientRecordFirstWarningShownRef.current = true;
      Alert.alert(
        MULTI_PATIENT_RECORD_FIRST_COPY.title,
        MULTI_PATIENT_RECORD_FIRST_COPY.body,
        [
          { text: MULTI_PATIENT_RECORD_FIRST_COPY.addDetailsFirst, style: 'default' },
          { text: MULTI_PATIENT_RECORD_FIRST_COPY.continueRecordingFirst, style: 'cancel' },
        ],
        { cancelable: true }
      );
    }
  }, [addSlot, recordFirstEnabled]);

  // -- Stash handlers --

  const executeStash = useCallback(() => {
    if (hasBlockingUploadWork()) {
      showUploadInProgressAlert();
      return;
    }
    if (hasUnresolvedHeldCopy()) {
      Alert.alert(
        METADATA_DIVERGENCE_COPY.stashBlockedTitle,
        METADATA_DIVERGENCE_COPY.stashBlockedBody,
      );
      return;
    }
    setIsStashing(true);
    (async () => {
      try {
        // Flush any pending debounced draft syncs so the stash payload carries
        // an accurate serverDraftId. Without this, a user who stashes quickly
        // after Finish would snapshot a null serverDraftId, and on resume
        // Submit would create a fresh server row instead of promoting.
        await Promise.all(
          sessionRef.current.slots.map((s) => flushScheduledDraft(s.id).catch(() => {}))
        );
        // A controlled restart or submit may have claimed the session while
        // draft flushing awaited storage/network. It owns the source files and
        // persisted identity until it settles, so stashing must fail closed.
        if (hasBlockingUploadWork()) {
          showUploadInProgressAlert();
          return;
        }
        // Re-check after the await: a divergence can land while draft flushing
        // waited on storage, and the cleanup below deletes every slot's draft.
        if (hasUnresolvedHeldCopy()) {
          Alert.alert(
            METADATA_DIVERGENCE_COPY.stashBlockedTitle,
            METADATA_DIVERGENCE_COPY.stashBlockedBody,
          );
          return;
        }
        // Read sessionRef (not the closure-captured `session`): flushScheduledDraft
        // dispatches SET_DRAFT_IDS, which updates the ref synchronously but does
        // not update the closure variable. Passing `session` risks stashing the
        // pre-flush snapshot with a missing serverDraftId.
        const postFlushSession = sessionRef.current;
        const success = await stashSession(postFlushSession);
        if (success) {
          // The stash persists the stable intent, canonical server ID, and any
          // complete pending-confirm hint, so retries continue with the same
          // row after resume. Local auto-saved draft metadata/audio is removed
          // because the stash
          // now owns the local files. The server draft row is intentionally
          // preserved via `serverDraftId` in the stash payload so resume ->
          // submit promotes the same draft in place.
          postFlushSession.slots.forEach((slot) => {
            deleteLocalSlotDraft(slot);
          });
          // The new stash supersedes the one we resumed from — release it so the
          // old SecureStore entry and audio dir don't linger. Done only after the
          // new stash has committed successfully, so the active session's data is
          // never orphaned between the two.
          releaseResumedStashIfAny();
          resetSession();
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          Alert.alert(STASH_COPY.savedTitle, STASH_COPY.savedBody);
        } else {
          // Only show the error dialog when there are recordings to recover.
          // If no segments exist the recording failed at the native level and a
          // 'Recording Error' alert was already shown — avoid a second misleading dialog.
          // stashSession returns false if no slots have audio, max stashes reached,
          // file copy failed, or SecureStore write failed. In all cases the active
          // session is untouched, so recordings (if any) are still here.
          // Include durable slots (empty segments, audio in audio.aac) — otherwise
          // a durable-only session that fails to stash (max stashes, SecureStore
          // write fail) shows no feedback and the user thinks it saved.
          const hasRecordings = postFlushSession.slots.some(slotHasRecoverableAudio);
          if (hasRecordings) {
            Alert.alert(STASH_COPY.saveFailedTitle, STASH_COPY.saveFailedBody);
          }
        }
      } catch (error) {
        if (__DEV__) console.error('[Record] stash failed:', error);
        Alert.alert(STASH_COPY.saveFailedTitle, STASH_COPY.saveFailedBody);
      } finally {
        setIsStashing(false);
      }
    })().catch(() => {
      setIsStashing(false);
    });
  }, [stashSession, resetSession, releaseResumedStashIfAny, deleteLocalSlotDraft, flushScheduledDraft, hasBlockingUploadWork, hasUnresolvedHeldCopy]);

  // Effect: execute pending stash after SAVE_AUDIO has been processed by React.
  // The audio capture effect sets pendingStashRef but defers the actual stash to here,
  // because session state hasn't been updated yet when the capture effect runs.
  // This effect fires on the re-render caused by saveAudio + unbindRecorder,
  // at which point session.slots includes the just-saved segment.
  useEffect(() => {
    if (pendingStashRef.current && !session.recorderBoundToSlotId) {
      pendingStashRef.current = false;
      executeStash();
    }
  }, [session, executeStash]);

  const handleStashSession = useCallback(() => {
    if (hasBlockingUploadWork()) {
      showUploadInProgressAlert();
      return;
    }
    // If recorder is active, stop it first — the effect will trigger executeStash
    if (session.recorderBoundToSlotId && (recorder.state === 'recording' || recorder.state === 'paused')) {
      Alert.alert(
        STASH_COPY.confirmStopTitle,
        STASH_COPY.confirmStopBody,
        [
          { text: STASH_COPY.cancel, style: 'cancel' },
          {
            text: STASH_COPY.confirmStopSave,
            onPress: () => {
              pendingStashRef.current = true;
              (async () => {
                try {
                  await recorder.stop();
                } catch {
                  pendingStashRef.current = false;
                  // stop() swallows errors — if we get here the effect should still fire
                }
              })().catch(() => {
                pendingStashRef.current = false;
              });
            },
          },
        ]
      );
      return;
    }

    // No recorder is live: stashing is non-destructive and fully reversible,
    // so save immediately — the success alert is the confirmation.
    executeStash();
  }, [session.recorderBoundToSlotId, recorder, executeStash, hasBlockingUploadWork]);

  const loadDraft = useCallback(
    async (slotId: string) => {
      try {
        let draft = await draftStorage.getDraft(slotId);
        if (!draft) {
          Alert.alert('Draft Not Found', 'This draft recording could not be found.');
          return;
        }
        // A durable draft that is already tombstoned was confirmed-uploaded (the
        // post-upload deleteDraft failed, leaving a stale "Not Submitted" card).
        // Resuming it would re-submit against the already-confirmed server row —
        // drop the stale metadata and tell the user it is already submitted.
        if (draft.durable && isValidDurableId(draft.durable.recordingId)) {
          const alreadyUploaded = await durableTombstone
            .has(draft.durable.recordingId)
            .catch(() => false);
          if (alreadyUploaded) {
            draftStorage.deleteDraft(slotId).catch(() => {});
            recoveryIntent.clearForDraftSlot(slotId).catch(() => {});
            Alert.alert(
              'Already Submitted',
              'This recording was already submitted. It has been cleared from your drafts.',
            );
            router.replace('/(tabs)/record' as any);
            return;
          }
        }
        let nativeManifest: Awaited<ReturnType<typeof durableRecorder.getManifest>> = null;
        if (draft.durable && user?.id) {
          nativeManifest = await durableRecorder.getManifest({
            userId: user.id,
            recordingId: draft.durable.recordingId,
          }).catch(() => null);
        }
        if (draft.uploadRestartPending) {
          if (!nativeManifest) {
            captureMessage('upload_restart_reconcile_manifest_unavailable', 'warning', {
              tags: { phase: 'upload_recovery', mode: 'durable' },
            });
            Alert.alert(
              'Upload Recovery Paused',
              'Captivet could not verify the saved upload identity. Your audio is still saved; restart the app and try again.',
            );
            return;
          }
          const reconciliation = await draftStorage.reconcileUploadAttemptReset(
            slotId,
            nativeManifest.uploadKeyOverride,
            nativeManifest.supersededUploadKey,
          );
          if (reconciliation === 'blocked') {
            captureMessage('upload_restart_reconcile_blocked', 'warning', {
              tags: { phase: 'upload_recovery', mode: 'durable' },
            });
            Alert.alert(
              'Upload Recovery Paused',
              'Captivet found mismatched saved upload state. Your audio is still saved and no new upload was started.',
            );
            return;
          }
          draft = await draftStorage.getDraft(slotId);
          if (!draft) {
            Alert.alert('Draft Not Found', 'This draft recording could not be found.');
            return;
          }
        }
        let restoredPendingConfirm = validatePendingConfirm(draft.pendingConfirm);
        if (!restoredPendingConfirm) {
          restoredPendingConfirm = validatePendingConfirm(nativeManifest?.pendingConfirm);
        }
        if (
          nativeManifest?.uploadKeyOverride &&
          nativeManifest.uploadKeyOverride !== draft.uploadKeyOverride
        ) {
          restoredPendingConfirm = null;
        }
        // Once R2 has accepted the bytes, confirmation no longer depends on a
        // local file. Only prompt to re-record when there is no valid proof.
        if (!restoredPendingConfirm) {
          for (const seg of draft.segments) {
            if (fileExists(seg.uri)) continue;
            Alert.alert(
              'Audio Not Found',
              'The recording audio was not found on this device. Would you like to start a new recording with the same patient details pre-filled?',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Re-record',
                  onPress: () => {
                    if (draft.serverDraftId) {
                      recordingsApi.delete(draft.serverDraftId, { reason: 'missing_audio_rerecord' }).catch(() => {});
                    }
                    draftStorage.deleteDraft(slotId).catch(() => {});
                    recoveryIntent.clearForDraftSlot(slotId).catch(() => {});
                    resetSession();
                    // Navigate to clear the param so this effect doesn't re-fire
                    router.replace('/(tabs)/record' as any);
                  },
                },
              ]
            );
            return;
          }
        }
        // DraftMetadata has no divergence field, so a restored draft would come
        // back with the conflict erased — and for a durable recording the
        // deterministic recording-id key means the very next submit can re-adopt
        // the disputed server row and purge the retained audio, never showing
        // the card. The persisted HOLD is the record that survives, so rebuild
        // the conflict from it. Fields are unknown here; the card renders
        // without the "Differs on:" line and still offers all three choices.
        const heldConflictKey = draft.durable?.recordingId ?? draft.slotId;
        // STRICT, and fail CLOSED. `has()` maps an unreadable list to false, and
        // this answer decides whether the conflict is shown at all — a transient
        // Keystore failure would restore the draft with no card while it still
        // carries the disputed server identity (or the deterministic durable
        // key), so the next submit re-adopts that row and purges the audio.
        // Showing the card when we are unsure costs a dismissal; not showing it
        // costs the recording.
        const holdState = await durableReconcileHold
          .hasStrict(heldConflictKey)
          .catch(() => 'unknown' as const);
        if (holdState === 'unknown') {
          // Neither answer is safe to invent here. Restoring WITHOUT the card
          // lets the next submit re-adopt a disputed row; restoring WITH one
          // fabricates a conflict on an ordinary unsubmitted draft, telling the
          // vet it is already on the server and offering to delete their only
          // copy. So do not restore at all — nothing is lost by asking again
          // once storage recovers.
          Alert.alert(
            METADATA_DIVERGENCE_COPY.draftUnavailableTitle,
            METADATA_DIVERGENCE_COPY.draftUnavailableBody
          );
          return;
        }
        const conflictHeld = holdState === 'held';

        // Local files are present or R2 proof is sufficient — restore session.
        const restoredSlot: PatientSlot = {
          id: draft.slotId,
          uploadIntentId: normalizeUploadIntentId(draft.uploadIntentId, draft.slotId),
          uploadKeyOverride: nativeManifest?.uploadKeyOverride ?? draft.uploadKeyOverride,
          supersededUploadKey:
            nativeManifest?.supersededUploadKey ?? draft.supersededUploadKey,
          uploadRecovery: null,
          metadataDivergence: conflictHeld
            ? {
                tier: 'identity',
                fields: [],
                recordingId: draft.serverDraftId ?? '',
              }
            : null,
          formData: draft.formData,
          pimsPatientIdExplicitlyCleared: isPimsPatientIdExplicitlyCleared(
            draft.formData.pimsPatientId,
            draft.pimsPatientIdExplicitlyCleared,
          ),
          audioState: 'stopped',
          segments: draft.segments,
          // Durable drafts reference audio.aac (empty segments); restore the pointer.
          durable: draft.durable ?? null,
          audioUri: draft.segments.at(-1)?.uri ?? null,
          audioDuration: draft.audioDuration,
          uploadStatus: 'pending',
          uploadProgress: 0,
          uploadError: null,
          serverRecordingId: null,
          draftSlotId: draft.slotId,
          serverDraftId:
            nativeManifest?.uploadKeyOverride &&
            nativeManifest.uploadKeyOverride !== draft.uploadKeyOverride
              ? null
              : draft.serverDraftId,
          // Fail closed after restart: if a local draft is attached to a server
          // draft, submit should send current formData with confirm-upload even
          // if an older build did not persist the dirty bit.
          draftMetadataDirty: draft.draftMetadataDirty || !!draft.serverDraftId,
          pendingConfirm: restoredPendingConfirm,
        };
        restoreSession([restoredSlot]);
        recoveryIntent.clearForDraftSlot(draft.slotId).catch(() => {});
      } catch (error) {
        if (__DEV__) console.warn('[Record] loadDraft failed:', error);
        Alert.alert('Error', 'Could not load the draft recording.');
      }
    },
    [resetSession, restoreSession, router, user?.id]
  );

  const { draftSlotId } = useLocalSearchParams<{ draftSlotId?: string }>();

  useEffect(() => {
    if (!draftSlotId) return;

    const currentSlots = sessionRef.current.slots;

    // Gather every draft currently represented in the session — these are
    // all Home-visible "Not Submitted" cards. Any discard path taken below
    // must preserve them, otherwise switching to one draft silently deletes
    // the others (they were never the user's intent to throw away).
    const preserveIds = new Set<string>([draftSlotId]);
    for (const s of currentSlots) {
      // Resumed-stash slots are excluded: their retained draftSlotId doesn't
      // map to a surviving local draft (see stashResumedSlotIdsRef), and
      // preserving it would strand the server row audio-less on discard.
      if (s.draftSlotId && !stashResumedSlotIdsRef.current.has(s.id)) {
        preserveIds.add(s.draftSlotId);
      }
    }
    const preserveList = Array.from(preserveIds);

    // If the target draft already lives in the session (user just pressed
    // Finish → Home → tapped the card for the same slot), the session is
    // already the draft. Scroll the pager to it, clear the param, done.
    const alreadyLoadedIndex = currentSlots.findIndex((s) => s.draftSlotId === draftSlotId);
    if (alreadyLoadedIndex >= 0) {
      setActiveIndex(alreadyLoadedIndex);
      router.replace('/(tabs)/record' as any);
      return;
    }

    // Drafted slots are durable on disk + server, so loading a different
    // draft doesn't lose them — we skip the warning dialog and let the
    // preserve list keep their rows intact (see isTrulyUnsavedSlot).
    const trulyUnsaved = currentSlots.some(isSlotTrulyUnsaved);

    if (trulyUnsaved) {
      Alert.alert(
        REPLACE_SESSION_COPY.title,
        REPLACE_SESSION_COPY.bodyLoadDraft,
        [
          { text: REPLACE_SESSION_COPY.cancel, style: 'cancel' },
          {
            text: REPLACE_SESSION_COPY.loadDraft,
            style: 'destructive',
            onPress: () => {
              (async () => {
                await discardCurrentSession({ preserveDraftSlotIds: preserveList });
                await loadDraft(draftSlotId);
              })().catch(() => {});
            },
          },
        ]
      );
      return;
    }

    // No live work to protect. Reset the in-memory session (preserving all
    // drafts) and load the target.
    (async () => {
      await discardCurrentSession({ preserveDraftSlotIds: preserveList });
      await loadDraft(draftSlotId);
    })().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Intentionally omit unsavedCount, discardCurrentSession, loadDraft, setActiveIndex, router; effect should only fire when route param changes, not on every state change
  }, [draftSlotId]);

  // Effect: check for pending drafts and update banner state.
  //
  // Depending on the whole `session` object was a real defect: the reducer
  // returns a new state object for EVERY action, including `UPDATE_FORM`, so
  // typing a patient name tore down and re-scheduled this effect once per
  // keystroke — each one a full `listDrafts()` sweep of SecureStore. And
  // `cancelWork()` cannot abort a sweep that already started, so the sweeps
  // piled up against the same serialized AndroidKeyStore. Production Sentry
  // measured `record_pending_draft_scan` at 11.6s.
  //
  // Only draft linkage and upload status can change whether a draft is pending
  // sync, so key the effect on a stable fingerprint of exactly those fields.
  // The array identity still changes every action; the STRING does not.
  const draftLinkageFingerprint = useMemo(
    () => session.slots.map((slot) => `${slot.draftSlotId ?? ''}:${slot.uploadStatus}`).join('|'),
    [session.slots]
  );
  // Storage-side writes this screen never dispatched. `usePendingDraftSync` is
  // mounted in the app layout and clears `pendingSync` in SecureStore without
  // touching any slot, so neither the fingerprint above nor the old whole-session
  // dependency would re-run the scan when a background sync settles — leaving
  // "syncing to server…" on screen after it had already succeeded.
  const [draftStoreRevision, setDraftStoreRevision] = useState(0);
  useEffect(() => {
    return draftStorage.subscribeDraftChanges(() => {
      setDraftStoreRevision((n) => n + 1);
    });
  }, []);

  // Effect: ask once per device whether to exempt Captivet from Android battery
  // optimization. Samsung One UI app-sleep kills the app mid-recording, and that
  // kill reaches no crash reporter at all. Queued behind the startup sweeps so
  // the dialog never lands while the screen is still settling. When this launch
  // found a prior process ended mid-capture the copy reports THAT — it does not
  // claim Android caused it, because a reboot looks identical from here.
  useEffect(() => {
    if (!user?.id) return;
    const promptUserId = user.id;
    const cancelWork = scheduleNonUrgentWork(
      'battery_opt_prompt',
      async (isExpired) => {
        await maybePromptBatteryOptimization(
          priorUncleanExitDetected(promptUserId),
          // Re-evaluated inside, right before the Alert: this callback can be
          // mid-await across a sign-out and cancelWork cannot stop it.
          () => !isExpired() && durableActiveStore.getUserId() === promptUserId,
        );
      },
      5_000,
      null,
      true,
    );
    return cancelWork;
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    const cancelWork = scheduleNonUrgentWork('record_pending_draft_scan', async () => {
      const drafts = await draftStorage.listDrafts();
      if (!cancelled) {
        setHasPendingDrafts(drafts.some((d) => d.pendingSync));
      }
    }, 1_500);
    return () => {
      cancelled = true;
      cancelWork();
    };
  }, [draftLinkageFingerprint, draftStoreRevision, user?.id]);

  // Effect: on mount (once per user), sweep local drafts whose audio files
  // are missing on disk. Those are "zombie" drafts — they'll render as "Not
  // Submitted" on Home but `loadDraft` can never restore them. They happen
  // when an older client stashed a session before stash preserved
  // `serverDraftId` (the stash deleted the draft audio on commit). Deleting
  // the server row + local metadata clears them from the UI.
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    const cancelWork = scheduleNonUrgentWork('orphan_cleanup', async (isExpired) => {
      const userScopeVersion = draftStorage.getUserScopeVersion();
      const isScopeValid = () =>
        !cancelled &&
        !isExpired() &&
        AppState.currentState === 'active' &&
        draftStorage.getUserId() === user.id &&
        draftStorage.getUserScopeVersion() === userScopeVersion;
      if (!isScopeValid()) return;
      const drafts = await draftStorage.listDraftsForUser(user.id);
      const snapshot = await getDraftPresenceSnapshot(
        user.id,
        linkedServerDraftIds(drafts),
      );
      if (!snapshot || !isScopeValid()) return;
      const cleaned = await draftStorage
        .cleanupOrphaned((serverDraftId) => recordingsApi.delete(serverDraftId, { reason: 'orphan_draft_cleanup' }), {
          getStatus: async (serverDraftId) =>
            snapshot.statusById.get(serverDraftId) ?? null,
          isOnline: isConnected !== false,
          userId: user.id,
          isScopeValid,
        })
        .catch(() => 0);
      if (isScopeValid() && cleaned > 0) {
        invalidateRecordingCaches(queryClient, 'draft_deleted');
      }
      // Sweep stale FFmpeg-split temp dirs from a previous session that may
      // have been force-quit mid-split. Live in-flight splits create their
      // own uniquely-timestamped subdir and are guarded by the orchestrator's
      // own try/catch — this only wipes leftovers.
      if (isScopeValid()) cleanupSplitTempDirs(user.id);
    }, 3_000, 10_000, true);
    return () => {
      cancelled = true;
      cancelWork();
    };
    // isConnected is read at sweep time (mount / user switch) on purpose — the
    // orphan sweep should not re-run on every connectivity flap; a mount-time
    // offline read simply fails the legacy reconcile closed (safe).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, queryClient]);

  // Effect: status-aware 30-day eviction of un-sent recordings (drafts +
  // stashes). Bounds disk growth on shared tablets WITHOUT silently destroying
  // clinical data: server-confirmed-uploaded drafts are swept silently inside
  // evictExpired; un-sent drafts/stashes are surfaced warn-first and only
  // deleted after the vet acknowledges the prompt. Keyed on user.id (not a
  // lifetime boolean) so a shared-tablet user switch (A → sign-out → B without
  // unmount) re-sweeps for each user instead of silently skipping everyone
  // after the first.
  const evictionSweptUserRef = useRef<string | null>(null);
  useEffect(() => {
    if (!user?.id) return;
    if (evictionSweptUserRef.current === user.id) return;
    evictionSweptUserRef.current = user.id;
    const online = isConnected !== false;
    let cancelled = false;
    const cancelWork = scheduleNonUrgentWork('thirty_day_eviction', async (isExpired) => {
      try {
        const userScopeVersion = draftStorage.getUserScopeVersion();
        const isScopeValid = () =>
          !cancelled &&
          !isExpired() &&
          AppState.currentState === 'active' &&
          draftStorage.getUserId() === user.id &&
          draftStorage.getUserScopeVersion() === userScopeVersion;
        if (!isScopeValid()) return;
        const drafts = await draftStorage.listDraftsForUser(user.id);
        const snapshot = await getDraftPresenceSnapshot(
          user.id,
          linkedServerDraftIds(drafts),
        );
        if (!isScopeValid()) return;
        const getStatus = async (id: string): Promise<string | null> => {
          // A failed/offline batch makes every linked row unknown. Continue
          // the warn-first age classification without treating an omission as
          // deletion proof: evictExpired preserves server-linked audio for
          // null statuses, while local-only drafts and stashes still surface.
          return snapshot?.statusById.get(id) ?? null;
        };
        const draftResult = await draftStorage.evictExpired(
          {
            maxAgeDays: 30,
            warnAgeDays: 23,
            isOnline: online,
            userId: user.id,
            isScopeValid,
          },
          getStatus
        );
        if (!isScopeValid()) return;
        const stashResult = await stashStorage.evictExpired({ maxAgeDays: 30, warnAgeDays: 23 });
        if (!isScopeValid()) return;

        const expiredDrafts = draftResult.expired;
        const expiredStashes = stashResult.expired;
        const totalExpired = expiredDrafts.length + expiredStashes.length;
        const totalExpiring = draftResult.expiring.length + stashResult.expiring.length;

        if (totalExpired > 0) {
          const n = totalExpired;
          const noun = n === 1 ? 'recording' : 'recordings';
          const verb = n === 1 ? 'is' : 'are';
          const obj = n === 1 ? 'it' : 'them';
          const extra = totalExpiring > 0 ? ` ${totalExpiring} more will expire soon.` : '';
          Alert.alert(
            'Recordings Expiring',
            `${n} ${noun} on this device ${verb} over 30 days old and still not sent for SOAP notes. Submit ${obj} now, or delete from this device?${extra}`,
            [
              { text: 'Keep for now', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: () => {
                  (async () => {
                    if (!isScopeValid()) return;
                    for (const draft of expiredDrafts) {
                      if (!isScopeValid()) return;
                      try {
                        if (draft.serverDraftId) {
                          await recordingsApi.delete(draft.serverDraftId, { reason: 'user_delete' }).catch(() => {});
                        }
                        if (!isScopeValid()) return;
                        await draftStorage.deleteDraftForUser(user.id, draft.slotId);
                      } catch {
                        // best-effort
                      }
                    }
                    for (const stash of expiredStashes) {
                      if (!isScopeValid()) return;
                      try {
                        await deleteStash(stash.id);
                      } catch {
                        // best-effort
                      }
                    }
                    if (isScopeValid()) {
                      invalidateRecordingCaches(queryClient, 'draft_deleted');
                    }
                  })().catch(() => {});
                },
              },
            ]
          );
        } else if (totalExpiring > 0 && __DEV__) {
          console.log(`[record] ${totalExpiring} unsent recording(s) approaching 30-day expiry`);
        }
      } catch (error) {
        if (__DEV__) console.error('[record] eviction sweep failed:', error);
      }
    }, 4_000, 10_000, true);
    return () => {
      cancelled = true;
      cancelWork();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per user; isConnected read via closure at mount
  }, [user?.id]);

  const handleResumeStash = useCallback(
    (stashId: string) => {
      const doResume = () => {
        (async () => {
          try {
            const slots = await resumeStashedSession(stashId);
            if (slots) {
              restoreSession(slots);
              // RESTORE_SESSION replaced every slot — flags for the previous
              // session's slot ids are moot (and must not leak onto restored
              // slots if an id ever recurs).
              unsyncedDraftAudioRef.current.clear();
              stashResumedSlotIdsRef.current.clear();
              // Stashing DELETED each slot's local draft (the stash became the
              // audio owner) and resume only restores the draftSlotId
              // identifier for server-draft promotion — the stash dir now
              // holds the ONLY copy. Mark every restored slot with audio as
              // unsynced so discard/replace flows warn instead of trusting
              // the retained draftSlotId as proof of a durable draft; the
              // flag clears when a new draft commit or upload re-secures the
              // audio (Codex P1, PR #143).
              for (const restored of slots) {
                if (slotHasRecoverableAudio(restored) && restored.uploadStatus !== 'success') {
                  unsyncedDraftAudioRef.current.add(restored.id);
                }
                // Any retained draftSlotId points at a draft that stashing
                // deleted — exclude it from discard preserve lists until a
                // fresh autoSaveDraft commits (see stashResumedSlotIdsRef).
                if (restored.draftSlotId && restored.uploadStatus !== 'success') {
                  stashResumedSlotIdsRef.current.add(restored.id);
                }
              }
              // Pin the stash entry so orphan cleanup cannot delete the audio
              // directory the active session is still reading from. The pin is
              // released when the session is resolved (upload / discard / re-stash);
              // if the app is killed first, the pin is cleared on next launch so
              // the user can resume again.
              resumedFromStashIdRef.current = stashId;
              markResumed(stashId).catch(() => {});
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
            }
          } catch (error) {
            if (__DEV__) console.error('[Record] resume stash failed:', error);
          }
        })().catch(() => {});
      };

      const currentSlots = sessionRef.current.slots;
      const preserveDraftSlotIds = collectPreserveDraftSlotIds(
        currentSlots,
        stashResumedSlotIdsRef.current
      );
      const trulyUnsaved = currentSlots.some(isSlotTrulyUnsaved);

      if (trulyUnsaved) {
        Alert.alert(
          REPLACE_SESSION_COPY.title,
          REPLACE_SESSION_COPY.bodyResumeStash,
          [
            { text: REPLACE_SESSION_COPY.cancel, style: 'cancel' },
            {
              text: REPLACE_SESSION_COPY.replace,
              style: 'destructive',
              onPress: () => {
                (async () => {
                  await discardCurrentSession({ preserveDraftSlotIds });
                  doResume();
                })().catch(() => {});
              },
            },
          ]
        );
      } else if (hasUnsavedRecordings) {
        // Only drafted (durable) slots in the session — nothing is actually at
        // risk, so skip the scary dialog, but still discard-with-preserve so
        // debounce timers/stash pins are cleaned up before the restore.
        (async () => {
          await discardCurrentSession({ preserveDraftSlotIds });
          doResume();
        })().catch(() => {});
      } else {
        doResume();
      }
    },
    [hasUnsavedRecordings, isSlotTrulyUnsaved, discardCurrentSession, resumeStashedSession, markResumed, restoreSession]
  );

  const handleDeleteStash = useCallback(
    (stashId: string) => {
      Alert.alert(
        STASH_COPY.deleteTitle,
        STASH_COPY.deleteBody,
        [
          { text: STASH_COPY.cancel, style: 'cancel' },
          {
            text: STASH_COPY.delete,
            style: 'destructive',
            onPress: () => {
              deleteStash(stashId).catch(() => {});
            },
          },
        ]
      );
    },
    [deleteStash]
  );

  // -- Edit handler --

  const handleEditRecording = useCallback(
    (slotId: string) => {
      const slot = session.slots.find((s) => s.id === slotId);
      if (isSlotUploadActive(slotId)) {
        showUploadInProgressAlert();
        return;
      }
      if (slot?.pendingConfirm) {
        Alert.alert(
          'Finish Submission First',
          'This recording has already been uploaded and is waiting for confirmation. Submit it again to finish, or choose Delete & Start Over before editing.',
        );
        return;
      }
      // v1: the waveform editor operates on legacy m4a segments. A durable AAC
      // recording (empty segments[], audio in audio.aac) is submitted as-is;
      // in-app editing of durable recordings is a follow-up.
      if (slot?.durable) {
        Alert.alert(
          'Editing Not Available',
          'This recording can be submitted as-is. Editing recordings captured with crash-safe recording is not supported yet.',
        );
        return;
      }
      if (!slot || slot.segments.length === 0) {
        Alert.alert('No Recording', 'Please record audio before editing.');
        return;
      }

      // Snapshot segments before navigating — avoids stale closure if session changes while editing.
      // Preserve peakMetering so the silent-audio guard keeps the fast path for
      // round-tripped segments that the user opened in the editor but didn't trim.
      const originalSegments = slot.segments.map((s) => ({
        uri: s.uri,
        duration: s.duration,
        peakMetering: s.peakMetering,
      }));

      // Set callback BEFORE input — editor reads input on mount, callback must be ready
      audioEditorBridge.setResultCallback((result) => {
        if (result) {
          // Delete old segment files that are no longer in the result
          const newUris = new Set(result.segments.map((s) => s.uri));
          originalSegments.forEach((seg) => {
            if (!newUris.has(seg.uri) && !isDraftOwnedUri(seg.uri)) {
              // draftStorage owns draft-dir files; the subsequent autoSaveDraft
              // overwrites them with the edited segment data, so deleting here
              // would race with the re-save and leave a half-cleaned dir.
              safeDeleteFile(seg.uri);
            }
          });
          // Segment set is about to change. The reducer clears the obsolete
          // pending hint while retaining the stable intent/canonical row.
          replaceAllSegments(result.slotId, result.segments);
          // Re-persist the edited segment set so a restart can't reopen the
          // pre-edit draft audio.
          pendingDraftSlotIdRef.current = result.slotId;
          pendingDraftMinSegmentCountRef.current = result.segments.length;
          pendingDraftRecoveryReasonRef.current.set(result.slotId, 'draft_finish');
        }
      });

      audioEditorBridge.setInput({ slotId, segments: originalSegments });

      router.push('/(app)/audio-editor' as any);
    },
    [isSlotUploadActive, session.slots, router, replaceAllSegments]
  );

  // Show stash list when session is clean and stashes exist
  const showStashList = !stashesLoading && stashCount > 0 && !hasUnsavedRecordings;

  // Show stash button when there are unsaved recordings to stash
  const canStash =
    hasUnsavedRecordings &&
    !isSubmittingAll &&
    !isStashing &&
    submitIntentCount === 0 &&
    uploadRestartCount === 0 &&
    finishingDraftSlotId === null;
  const isAnyUploading = session.slots.some((s) => s.uploadStatus === 'uploading');

  // Upload overlay visibility
  const showOverlay = isSubmittingAll || submittingSlotId !== null || session.slots.some((s) => s.uploadStatus === 'uploading');

  // 1-based position of the slot currently uploading within the batch. The
  // completed count can NOT stand in for this: it only counts successes, so
  // after a failed slot it stalls and the hidden-overlay banner would keep
  // announcing "Uploading 1 of N" for every later slot (Codex P2, PR #143).
  const activeBatchPosition = (() => {
    if (submittingSlotId) {
      const idx = batchSlotIds.indexOf(submittingSlotId);
      if (idx >= 0) return idx + 1;
    }
    return countBatchCompleted(session.slots, batchSlotIds) + 1;
  })();

  // Un-hide for the next batch once the current one fully resolves.
  useEffect(() => {
    if (!showOverlay && uploadOverlayHidden) setUploadOverlayHidden(false);
  }, [showOverlay, uploadOverlayHidden]);

  // Pagination indicator
  const paginationText =
    session.slots.length > 6
      ? `${session.activeIndex + 1} of ${session.slots.length}`
      : null;

  const recorderBusy =
    session.recorderBoundToSlotId !== null &&
    (recorder.state === 'recording' || recorder.state === 'paused');
  const hasActiveRecording = session.slots.some(slotHasLiveRecorder) || finishingDraftSlotId !== null;

  const renderSlotCard = useCallback(
    ({ item, index }: { item: PatientSlot; index: number }) => {
      const isRecorderOwner = session.recorderBoundToSlotId === item.id;
      return (
        <PatientSlotCard
          slot={item}
          slotIndex={index}
          totalSlots={session.slots.length}
          isRecorderOwner={isRecorderOwner}
          recorderState={isRecorderOwner ? recorder.state : 'idle'}
          recorderDuration={isRecorderOwner ? recorder.duration : 0}
          getLiveStats={recorder.getLiveStats}
          isStarting={startingSlotId === item.id || queuedStartSlotIds.includes(item.id) || (isRecorderOwner && recorder.isStarting)}
          startInFlight={startingSlotId !== null || recorder.isStarting}
          recorderBusy={recorderBusy && !isRecorderOwner}
          isFinishSaving={finishingDraftSlotId === item.id}
          templates={templates}
          templatesLoading={templatesLoading}
          defaultTemplateId={effectiveDefaultTemplate?.id ?? null}
          onSetDefaultTemplate={handleSetDefaultTemplate}
          defaultTemplateSaving={defaultTemplateSavingId === item.formData.templateId}
          width={screenWidth}
          onUpdateForm={handleUpdateForm}
          onStart={handleStart}
          onPause={handlePause}
          onResume={handleResume}
          onStop={handleStop}
          onRecordAgain={handleRecordAgain}
          onContinueRecording={handleContinueRecording}
          onRemove={handleRemove}
          onSubmitSingle={handleSubmitSingle}
          onEditRecording={handleEditRecording}
          submitBlockedByLiveRecording={slotHasLiveRecorder(item)}
          recordFirstEnabled={recordFirstEnabled}
          onOpenDivergentRecording={handleOpenDivergentRecording}
          onReleaseLocalCopy={handleReleaseLocalCopy}
          onResubmitAsNew={handleResubmitAsNew}
          onDismissDivergence={handleDismissDivergence}
          divergenceActionsBusy={reconcilingSlotId !== null}
        />
      );
    },
    [
      handleDismissDivergence,
      handleOpenDivergentRecording,
      reconcilingSlotId,
      handleReleaseLocalCopy,
      handleResubmitAsNew,
      session.recorderBoundToSlotId,
      session.slots.length,
      recorder.state,
      recorder.duration,
      recorder.getLiveStats,
      recorder.isStarting,
      startingSlotId,
      queuedStartSlotIds,
      recorderBusy,
      templates,
      templatesLoading,
      effectiveDefaultTemplate?.id,
      handleSetDefaultTemplate,
      defaultTemplateSavingId,
      screenWidth,
      handleUpdateForm,
      handleStart,
      handlePause,
      handleResume,
      handleStop,
      handleRecordAgain,
      handleContinueRecording,
      handleRemove,
      handleSubmitSingle,
      handleEditRecording,
      slotHasLiveRecorder,
      finishingDraftSlotId,
      recordFirstEnabled,
    ]
  );

  // Stable renderItem reference for FlatList — avoids re-rendering all visible items
  // when the callback recreates. Combined with React.memo on PatientSlotCard,
  // this ensures only slots with actual prop changes re-render.
  const renderSlotCardRef = useRef(renderSlotCard);
  renderSlotCardRef.current = renderSlotCard;
  const stableRenderSlotCard = useCallback(
    (info: { item: PatientSlot; index: number }) => renderSlotCardRef.current(info),
    []
  );

  /**
   * Tells the FlatList that a cell's OUTPUT changed even though `data` did not.
   *
   * FlatList is a PureComponent, `data` is `session.slots`, and
   * `stableRenderSlotCard` is deliberately identity-stable — so with no
   * `extraData` the shallow prop compare saw nothing and the cells never
   * re-rendered. Tapping Start sets only `startingSlotId`, so the spinner and
   * the `startInFlight` lockout on the other Start buttons could not paint until
   * `session.slots` itself changed, i.e. after the native start latency they
   * exist to mask — reinstating the exact delayed-feedback and swallowed-retap
   * behaviour the record-perf work removed (Codex round 13).
   *
   * Mirrors renderSlotCard's deps with two deliberate omissions: `recorder.duration`
   * and `recorder.getLiveStats`. The live timer and metering re-render
   * RecorderLiveReadout alone (see PatientSlotCard), so including duration would
   * re-render every card twice a second — the render thrash that work removed.
   */
  const slotCardExtraData = useMemo(
    () => ({
      recorderBoundToSlotId: session.recorderBoundToSlotId,
      slotCount: session.slots.length,
      recorderState: recorder.state,
      recorderIsStarting: recorder.isStarting,
      startingSlotId,
      queuedStartSlotIds,
      recorderBusy,
      finishingDraftSlotId,
      reconcilingSlotId,
      templates,
      templatesLoading,
      defaultTemplateId: effectiveDefaultTemplate?.id ?? null,
      defaultTemplateSavingId,
      screenWidth,
      recordFirstEnabled,
      handleUpdateForm,
      handleStart,
      handlePause,
      handleResume,
      handleStop,
      handleRecordAgain,
      handleContinueRecording,
      handleRemove,
      handleSubmitSingle,
      handleEditRecording,
      handleSetDefaultTemplate,
      handleOpenDivergentRecording,
      handleReleaseLocalCopy,
      handleResubmitAsNew,
      handleDismissDivergence,
      slotHasLiveRecorder,
    }),
    [
      session.recorderBoundToSlotId,
      session.slots.length,
      recorder.state,
      recorder.isStarting,
      startingSlotId,
      queuedStartSlotIds,
      recorderBusy,
      finishingDraftSlotId,
      reconcilingSlotId,
      templates,
      templatesLoading,
      effectiveDefaultTemplate?.id,
      defaultTemplateSavingId,
      screenWidth,
      recordFirstEnabled,
      handleUpdateForm,
      handleStart,
      handlePause,
      handleResume,
      handleStop,
      handleRecordAgain,
      handleContinueRecording,
      handleRemove,
      handleSubmitSingle,
      handleEditRecording,
      handleSetDefaultTemplate,
      handleOpenDivergentRecording,
      handleReleaseLocalCopy,
      handleResubmitAsNew,
      handleDismissDivergence,
      slotHasLiveRecorder,
    ]
  );

  const getItemLayout = useCallback(
    (_: any, index: number) => ({
      length: screenWidth,
      offset: screenWidth * index,
      index,
    }),
    [screenWidth]
  );

  return (
    <SafeAreaView className="screen">
      {/* Header */}
      <View className="px-5 pt-3 pb-2 bg-surface">
        <View className="flex-row justify-between items-start">
          <View className="flex-1">
            <Text
              className="text-display font-bold text-content-primary"
              accessibilityRole="header"
            >
              Record Appointment
            </Text>
            <Text className="text-body text-content-tertiary mt-1">
              Record a live appointment and generate a SOAP note
            </Text>
          </View>
          {canStash && (
            <View className="ml-3 mt-1">
              <Button
                variant="secondary"
                size="sm"
                onPress={() => {
                  // Stay tappable at capacity so the limit and remedy are
                  // explained instead of a silently dead 'Saved Full' button.
                  if (isAtCapacity) {
                    Alert.alert(STASH_COPY.atCapacityTitle, STASH_COPY.atCapacityBody(MAX_STASHES));
                    return;
                  }
                  handleStashSession();
                }}
                disabled={isAnyUploading || submitIntentCount > 0 || uploadRestartCount > 0}
                loading={isStashing}
                accessibilityLabel="Save session for later"
                accessibilityState={{
                  disabled: isAnyUploading || submitIntentCount > 0 || uploadRestartCount > 0,
                }}
              >
                {isAtCapacity ? STASH_COPY.savedFull(MAX_STASHES) : STASH_COPY.saveForLater}
              </Button>
            </View>
          )}
        </View>
      </View>

      {/* Stashed Sessions */}
      {showStashList && (
        <View className="px-5 pb-2">
          <Text className="text-body-sm font-semibold text-content-secondary mb-2">
            {STASH_COPY.sectionTitle(stashCount)}
          </Text>
          {stashes.map((stash) => (
            <StashedSessionCard
              key={stash.id}
              stash={stash}
              onResume={() => handleResumeStash(stash.id)}
              onDelete={() => handleDeleteStash(stash.id)}
            />
          ))}
        </View>
      )}

      {/* Compact progress banner while the upload overlay is hidden */}
      {showOverlay && uploadOverlayHidden && (
        <Pressable
          onPress={() => setUploadOverlayHidden(false)}
          accessibilityRole="button"
          accessibilityLabel={UPLOAD_OVERLAY_COPY.backgroundProgress(
            activeBatchPosition,
            Math.max(batchSlotIds.length, 1)
          )}
          className="mx-5 mb-2 px-3 py-3 bg-brand-50 dark:bg-surface-sunken border border-brand-300 dark:border-border-default rounded-lg flex-row items-center"
        >
          <ActivityIndicator size="small" color={colors.brand500} />
          <Text className="text-body-sm font-medium text-content-body flex-1 ml-3" numberOfLines={2}>
            {UPLOAD_OVERLAY_COPY.backgroundProgress(
              activeBatchPosition,
              Math.max(batchSlotIds.length, 1)
            )}
          </Text>
        </Pressable>
      )}

      {/* Pending Drafts Banner */}
      {hasPendingDrafts && (
        <View className="mx-5 mb-2 px-3 py-2 bg-status-warning border border-status-warning rounded-lg flex-row items-center">
          <Text className="text-body-sm text-status-warning flex-1">
            {isConnected === false ? RECORD_BANNERS.pendingDraftOffline : RECORD_BANNERS.pendingDraftOnline}
          </Text>
        </View>
      )}

      {/* Interruption Banner — call/Siri/headphones interrupted recording.
          Stays visible from the moment the partial segment is saved until
          AppState returns to 'active' and recording auto-resumes. */}
      {(interruptionPendingResume || durableInterruptionNotice) && (
        <View
          className="mx-5 mb-2 px-3 py-3 bg-status-warning border-2 border-status-warning rounded-lg flex-row items-center"
          accessibilityLiveRegion="assertive"
          accessibilityRole="alert"
        >
          <View className="w-2 h-2 rounded-full bg-status-warning-fg mr-3" />
          <Text className="text-body-sm font-semibold text-status-warning flex-1">
            {interruptionPendingResume
              ? RECORDER_TRANSITION_COPY.interruptedPaused
              : RECORDER_TRANSITION_COPY.interruptedSaved}
          </Text>
          {!interruptionPendingResume && (
            <Pressable
              onPress={() => setDurableInterruptionNotice(false)}
              accessibilityRole="button"
              accessibilityLabel="Dismiss interruption notice"
              hitSlop={10}
              style={{ minHeight: 44, justifyContent: 'center' }}
            >
              <Text className="text-body-sm font-semibold text-status-warning underline">
                {RECORDER_TRANSITION_COPY.dismiss}
              </Text>
            </Pressable>
          )}
        </View>
      )}

      {/* Patient Tab Strip */}
      <View className="px-3 pb-1">
        <PatientTabStrip
          slots={session.slots}
          activeIndex={session.activeIndex}
          onSelectIndex={selectPatientIndex}
          onAddPatient={handleAddPatient}
        />
      </View>

      {/* Horizontal pager */}
      <FlatList
        ref={pagerRef}
        data={session.slots}
        renderItem={stableRenderSlotCard}
        extraData={slotCardExtraData}
        keyExtractor={(item) => item.id}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onMomentumScrollEnd={handleScrollEnd}
        onScrollBeginDrag={handleScrollBegin}
        getItemLayout={getItemLayout}
        initialScrollIndex={session.activeIndex}
        style={{ flex: 1 }}
        removeClippedSubviews={true}
        maxToRenderPerBatch={2}
        windowSize={3}
        initialNumToRender={1}
      />

      {/* Pagination dots or text */}
      {session.slots.length > 1 && (
        <View
          className="items-center py-2 bg-surface"
          accessibilityRole="adjustable"
          accessibilityLabel={`Patient ${session.activeIndex + 1} of ${session.slots.length}`}
          accessibilityLiveRegion="polite"
          // adjustable without actions is a lie to screen readers — wire the
          // swipe gestures to actually change the active patient.
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(event) => {
            const delta = event.nativeEvent.actionName === 'increment' ? 1 : -1;
            const next = Math.max(0, Math.min(session.activeIndex + delta, session.slots.length - 1));
            if (next !== session.activeIndex) selectPatientIndex(next);
          }}
        >
          {paginationText ? (
            // w-full — the container is items-center, so this shrink-wraps and Android
            // "Bold text" can drop the tail of "3 of 8", losing the user's position in
            // a multi-patient session (CLAUDE.md > UI Gotchas).
            <Text className="text-caption text-content-tertiary text-center w-full">{paginationText}</Text>
          ) : (
            <View className="flex-row gap-1.5">
              {session.slots.map((slot, i) => (
                <View
                  key={slot.id}
                  className={`w-2 h-2 rounded-full ${
                    i === session.activeIndex ? 'bg-brand-500' : 'bg-border-strong'
                  }`}
                  accessibilityLabel={`Patient ${i + 1}${i === session.activeIndex ? ', current' : ''}`}
                />
              ))}
            </View>
          )}
        </View>
      )}

      {/* Submit All panel */}
      <SubmitPanel
        slots={session.slots}
        isSubmitting={isSubmittingAll}
        onSubmitAll={handleSubmitAll}
        hasActiveRecording={hasActiveRecording}
        recordFirstEnabled={recordFirstEnabled}
      />

      {/* Upload overlay */}
      <UploadOverlay
        visible={showOverlay && !uploadOverlayHidden}
        slots={session.slots}
        currentSlotId={submittingSlotId}
        batchSlotIds={batchSlotIds}
        isMulti={isSubmittingAll}
        onHide={() => setUploadOverlayHidden(true)}
      />
      <Toast message={pauseToast ?? ''} visible={pauseToast !== null} onHide={hidePauseToast} />
    </SafeAreaView>
  );
}

export default function RecordScreen() {
  const user = useAuthUser();
  const colors = useThemeColors();
  const [permissionStatus, setPermissionStatus] = useState<'checking' | 'granted' | 'denied'>('checking');
  const roleBlocked = !!user && !canRecordAppointments(user.role);

  useEffect(() => {
    if (roleBlocked) return;
    let cancelled = false;
    const watchdog = setTimeout(() => {
      if (!cancelled) {
        setPermissionStatus('denied');
      }
    }, 4_000);

    measurePhase('record_screen_mount_work', { work: 'permission_check' }, async () => {
      const { granted } = await getRecordingPermissionsAsync();
      if (!cancelled) {
        setPermissionStatus(granted ? 'granted' : 'denied');
      }
    })
      .catch(() => {
        if (!cancelled) {
          setPermissionStatus('denied');
        }
      })
      .finally(() => {
        clearTimeout(watchdog);
      });
    return () => {
      cancelled = true;
      clearTimeout(watchdog);
    };
  }, [roleBlocked]);

  if (roleBlocked) {
    return <RecordingRoleGate />;
  }

  if (permissionStatus === 'checking') {
    return (
      <ScreenContainer>
        <View className="flex-1 justify-center items-center">
          <ActivityIndicator size="large" color={colors.brand500} />
        </View>
      </ScreenContainer>
    );
  }

  if (permissionStatus === 'denied') {
    return <PermissionGate onGranted={() => setPermissionStatus('granted')} />;
  }

  return <RecordingSession />;
}
