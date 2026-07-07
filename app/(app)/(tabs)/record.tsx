import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { View, Text, Alert, ActivityIndicator, Linking, useWindowDimensions, FlatList, AppState, InteractionManager } from 'react-native';
import type { AppStateStatus } from 'react-native';
import { useRouter, useNavigation, useLocalSearchParams } from 'expo-router';
import { usePreventRemove } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { Mic } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { safeDeleteFile, safeDeleteDirectory, fileExists, writeFilePrefix } from '../../../src/lib/fileOps';
import { getInfoAsync } from 'expo-file-system/legacy';
import { Paths } from 'expo-file-system';
import { maybeSplitForUpload, cleanupSplitTempDirs } from '../../../src/lib/oversizedSplit';
import { checkAudioSilenceForUpload } from '../../../src/lib/ffmpeg';
import {
  MULTI_PATIENT_RECORD_FIRST_COPY,
  OVERSIZED_CONFIRM_COPY,
  RECORD_BANNERS,
  SILENT_CHECK_COPY,
  TEMPLATE_DEFAULT_COPY,
} from '../../../src/constants/strings';
import NetInfo, { useNetInfo } from '@react-native-community/netinfo';
import { draftStorage } from '../../../src/lib/draftStorage';
import { stashStorage } from '../../../src/lib/stashStorage';
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
import { durableTombstone } from '../../../src/lib/durableAudio/tombstone';
import { isValidDurableId } from '../../../src/lib/durableAudio/paths';
import { durableRecoveryStore } from '../../../src/lib/durableAudio/recoveryState';
import { getSecureRandomHex } from '../../../src/lib/random';
import { useAudioRecorder } from '../../../src/hooks/useAudioRecorder';
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
  isTransientUploadError,
  type RecordingDeleteReason,
} from '../../../src/api/recordings';
import { ApiError } from '../../../src/api/client';
import { deleteRecordingWithRetry, patchDraftMetadataWithRetry } from '../../../src/lib/retryableCleanup';
import {
  trackEvent,
  type NetworkState,
  type AutoStashReason,
  type SubmitDiagnosticsProps,
} from '../../../src/lib/analytics';
import { breadcrumb, captureException, captureMessage, measurePhase } from '../../../src/lib/monitoring';
import { reportClientError } from '../../../src/api/telemetry';
import { DRAFT_DEBOUNCE_MS } from '../../../src/config';
import { audioEditorBridge } from '../../../src/lib/audioEditorBridge';
import { recordingActivity } from '../../../src/lib/recordingActivity';
import { recordSubmitAttempt } from '../../../src/lib/submitTiming';
import { setSessionActivity } from '../../../src/lib/sessionActivity';
import { templatePreference } from '../../../src/lib/templatePreference';
import { invalidateRecordingCaches } from '../../../src/lib/recordingQueryCache';
import {
  canRecordAppointments,
  RECORD_APPOINTMENT_PERMISSION_MESSAGE,
  RECORD_APPOINTMENT_PERMISSION_TITLE,
} from '../../../src/lib/recordingPermissions';
import { PatientTabStrip } from '../../../src/components/PatientTabStrip';
import { PatientSlotCard } from '../../../src/components/PatientSlotCard';
import { SubmitPanel } from '../../../src/components/SubmitPanel';
import { StashedSessionCard } from '../../../src/components/StashedSessionCard';
import { UploadOverlay } from '../../../src/components/UploadOverlay';
import { ScreenContainer } from '../../../src/components/ui/ScreenContainer';
import { Button } from '../../../src/components/ui/Button';
import type { AudioSegment, PatientSlot } from '../../../src/types/multiPatient';
import type { CreateRecording } from '../../../src/types';

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
//   - aborts: request timeout / cancel (AbortError), which the transient regex
//     does not match (Sentry REACT-NATIVE-W)
function isRecoverableSubmitFailure(error: unknown): boolean {
  if (isExpectedSubmitApiFailure(error)) return true;
  if (isTransientUploadError(error)) return true;
  if (getUploadPhase(error) === 'patch_draft') return true;
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
    for (const segment of slot.segments) {
      const result = await checkAudioSilenceForUpload(segment.uri);
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
  } catch {
    return { silent: false, inconclusive: true, reason: 'ffmpeg_error' };
  }
}

async function sumSegmentSizes(segments: AudioSegment[]): Promise<number> {
  let totalBytes = 0;
  for (const segment of segments) {
    const info = await getInfoAsync(segment.uri);
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

function scheduleNonUrgentWork(
  label: string,
  work: () => Promise<void>,
  fallbackMs = 2_500
): () => void {
  let cancelled = false;
  let started = false;
  const run = () => {
    if (cancelled || started) return;
    started = true;
    measurePhase(label, undefined, work).catch(() => {});
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
function confirmSilentUpload(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      SILENT_CHECK_COPY.title,
      SILENT_CHECK_COPY.body,
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
  const recordFirstEnabled = user?.capabilities?.includes('record_first') ?? false;
  const recorder = useAudioRecorder();
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

  /**
   * Best-effort delete a server recording that was left dangling because the
   * segment set it covered was replaced or extended (e.g. continueRecording,
   * clearAudio, replaceAllSegments). The server also has its own cleanup for
   * abandoned "uploading" rows, so failures here are non-fatal.
   */
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

  /**
   * Editing metadata on a slot with a pendingConfirm hint invalidates it: the
   * server record the hint points to was created with the OLD formData, and
   * the retry path in the API short-circuits to confirmUpload without
   * re-sending formData. The reducer drops the hint on UPDATE_FORM; this
   * wrapper best-effort deletes the now-orphaned server record before
   * dispatching, matching the existing pattern from continueRecording/
   * clearAudio/replaceAllSegments. For clientName edits — which fan out to
   * all slots — we walk every slot and delete each orphan.
   */
  const handleUpdateForm = useCallback(
    (slotId: string, field: keyof CreateRecording, value: string | boolean | undefined) => {
      if (field === 'clientName') {
        session.slots.forEach((s) => {
          if (s.pendingConfirm && s.uploadStatus !== 'success') {
            deleteOrphanServerRecording(s);
          }
        });
      } else {
        const target = session.slots.find((s) => s.id === slotId);
        if (target && target.pendingConfirm && target.uploadStatus !== 'success') {
          deleteOrphanServerRecording(target);
        }
      }
      updateForm(slotId, field, value);
    },
    [session.slots, updateForm, deleteOrphanServerRecording]
  );

  const [isSubmittingAll, setIsSubmittingAll] = useState(false);
  const [submittingSlotId, setSubmittingSlotId] = useState<string | null>(null);
  const [totalSlotsToUpload, setTotalSlotsToUpload] = useState(0);
  const [isStashing, setIsStashing] = useState(false);
  const [finishingDraftSlotId, setFinishingDraftSlotId] = useState<string | null>(null);
  const [hasPendingDrafts, setHasPendingDrafts] = useState(false);
  // Set when an audio session interruption (incoming call, Siri, etc.) tore
  // down the recording mid-stream. The hook captures the partial segment and
  // transitions to `'interrupted'`; we save it and remember which slot to
  // resume in once AppState returns to 'active' (call ended).
  const [interruptionPendingResume, setInterruptionPendingResume] = useState<{ slotId: string } | null>(null);
  // The AppState handler reads this from a ref — its effect deps are pinned
  // to avoid re-subscribing AppState on every state mutation.
  const interruptionPendingResumeRef = useRef<{ slotId: string } | null>(null);
  const netInfo = useNetInfo();
  const isConnected = netInfo.isConnected;
  // Derives a coarse connection descriptor for telemetry. Don't leak SSIDs or
  // carrier names — only the type bucket.
  const networkStateForTelemetry = (): NetworkState => {
    if (netInfo.isConnected === false) return 'none';
    if (netInfo.type === 'wifi') return 'wifi';
    if (netInfo.type === 'cellular') return 'cellular';
    if (netInfo.isConnected === true) return 'unknown';
    return 'unknown';
  };
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
  }, []);
  const removePendingStart = useCallback((slotId: string) => {
    const q = pendingStartSlotQueueRef.current;
    const idx = q.indexOf(slotId);
    if (idx !== -1) q.splice(idx, 1);
  }, []);
  // Track pending stash for "stop recorder then stash" flow
  const pendingStashRef = useRef(false);
  // Track pending draft for "stop recorder then auto-save draft" flow
  const pendingDraftSlotIdRef = useRef<string | null>(null);
  const pendingDraftMinSegmentCountRef = useRef<number>(0);
  const pendingDraftRecoveryReasonRef = useRef<Map<string, RecoveryIntentReason>>(new Map());
  // Ref for startRecordingForSlot to avoid hoisting issues in the effect
  const startRecordingRef = useRef<(slotId: string) => void>(() => {});
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
  // Guard: if upload wins the race against deferred local draft persistence, auto-save
  // must immediately clean up the late draft instead of leaving it behind locally.
  const completedUploadSlotIdsRef = useRef<Set<string>>(new Set());
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
  }, [cancelScheduledDraft]);

  const clearSubmitIntent = useCallback((slotIds: string[]) => {
    slotIds.forEach((slotId) => {
      submitIntentSlotIdsRef.current.delete(slotId);
    });
  }, []);

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
    if (effectiveDefaultTemplate && session.slots.length === 1 && !session.slots[0].formData.templateId) {
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
    }
    setInterruptionPendingResume({ slotId });
    interruptionPendingResumeRef.current = { slotId };
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    breadcrumb('record', 'interruption_paused', { slot_id: slotId });
    recorder.resetWithoutDelete();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally fires only on the recorder transition; reading session/refs from current render is correct
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
      const slotsToPersist = sessionRef.current.slots.filter(
        (slot) => (slot.segments.length > 0 || !!slot.durable) && slot.uploadStatus !== 'success'
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
      if (recorder.state === 'recording' || recorder.state === 'paused') {
        try {
          await recorder.stop();
        } catch {
          // stop() already performs internal cleanup
        }
      }
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
      // Best-effort delete any server recording left mid-confirm — the user is
      // abandoning this session entirely.
      deleteOrphanServerRecording(slot);
      // Also delete the auto-saved draft (local + server) so the discarded
      // recording doesn't linger as a "Not Submitted" row on Home — unless
      // the caller asked us to keep it (e.g. resume-from-Home is about to
      // load that draft and would otherwise read a freshly-deleted key).
      if (!slot.draftSlotId || !preserve.has(slot.draftSlotId)) {
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

    resetSession();
  }, [session.slots, session.recorderBoundToSlotId, recorder, unbindRecorder, resetSession, releaseResumedStashIfAny, deleteOrphanServerRecording, deleteSlotDraft, cancelScheduledDraft, user?.id]);

  // Navigation guard: only active when there are truly unsaved recordings (not yet uploaded)
  const unsavedCount = session.slots.filter(
    (s) => (s.segments.length > 0 && s.uploadStatus !== 'success') ||
            // A durable slot has empty segments (audio in audio.aac); count it as
            // unsaved whenever it hasn't uploaded, or the leave guard would let a
            // finished-but-unsubmitted durable recording slip away without warning.
            (!!s.durable && s.uploadStatus !== 'success') ||
            s.audioState === 'recording' || s.audioState === 'paused'
  ).length;

  usePreventRemove(unsavedCount > 0 && !isSubmittingAll, ({ data }) => {
    Alert.alert(
      'Discard Recordings?',
      unsavedCount === 1
        ? 'You have 1 unsubmitted recording. Leaving will discard it.'
        : `You have ${unsavedCount} unsubmitted recordings. Leaving will discard them.`,
      [
        { text: 'Stay', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => {
            (async () => {
              await discardCurrentSession();
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
        (async () => {
          try {
            await recorder.pause();
            setAudioState(leavingSlotId, 'paused');
          } catch {
            try { await recorder.stop(); } catch {}
          }
        })().catch(() => {});
      }
      if (opts?.fromSwipe) swipeChangeRef.current = true;
      setActiveIndex(index);
    },
    [session.activeIndex, session.recorderBoundToSlotId, recorder, setActiveIndex, setAudioState]
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
    [session.recorderBoundToSlotId, session.slots, recorder, user?.role]
  );

  const startRecordingForSlot = useCallback(
    (slotId: string) => {
      if (startInFlightRef.current) return;
      startInFlightRef.current = true;
      (async () => {
        let resumeDurableRecordingId: string | null = null;
        try {
          // Server-enforced min-version floor: block STARTING new capture (fresh or
          // Resume→Continue — every mic start funnels through here) on a build known
          // to be below the floor. Await bounded floor hydration FIRST so an offline
          // cold start can't race past a persisted-but-not-yet-loaded floor.
          // Already-captured audio stays uploadable; unknown floor / unknown current
          // version fails open (allow) — fail-closed only on a KNOWN-below-floor build.
          await ensureFloorHydrated();
          if (getRecordStartGate() === 'block') {
            breadcrumb('record', 'record_start_blocked_min_version', {});
            Alert.alert(
              'Update Required',
              'A newer version of Captivet is required to start new recordings. Please update the app from the store. Recordings you have already captured can still be submitted.',
            );
            return;
          }
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
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
            resumeDurableRecordingId = existingDurable.recordingId;
            await raceDurableActiveWrite(
              durableActiveStore.setActive(existingDurable.recordingId, slotId, new Date().toISOString()),
            );
            await withDurableOpWatchdog(
              recorder.resumeDurable({ userId: user.id, slotId, durable: existingDurable }),
              'resume',
            );
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
              const recordingId = newDurableRecordingId();
              // Write the active pointer BEFORE start (death-surviving breadcrumb),
              // but bound the SecureStore write so a hung Keystore can't strand the
              // start handler before the watchdog/finally — see raceDurableActiveWrite.
              await raceDurableActiveWrite(
                durableActiveStore.setActive(recordingId, slotId, new Date().toISOString()),
              );
              await withDurableOpWatchdog(
                recorder.start({ userId: user.id, slotId, recordingId }),
                'start',
              );
            } else {
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
        } catch (error) {
          unbindRecorder();
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
        }
      })().catch(() => {
        startInFlightRef.current = false;
      });
    },
    [recorder, bindRecorder, unbindRecorder, setAudioState, recordFirstEnabled, user?.id]
  );

  // Keep the ref in sync for the effect
  startRecordingRef.current = startRecordingForSlot;

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
      if (slot?.durable && (slot.uploadStatus === 'success' || slot.durable.recoveredAudioUri)) {
        Alert.alert(
          'Recording Complete',
          'This recording can be submitted as-is or deleted and started over.',
        );
        return;
      }
      const beginContinue = () => {
        if (!session.recorderBoundToSlotId || session.recorderBoundToSlotId === slotId) {
          recorder.resetWithoutDelete();
        }
        if (slot) deleteOrphanServerRecording(slot);
        continueRecording(slotId);
        if (slot?.durable) startRecordingForSlot(slotId);
      };
      if (slot?.durable && session.recorderBoundToSlotId && session.recorderBoundToSlotId !== slotId) {
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
                  if (slot) deleteOrphanServerRecording(slot);
                  continueRecording(slotId);
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
          if (slot) deleteOrphanServerRecording(slot);
          continueRecording(slotId);
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
    },
    [session.recorderBoundToSlotId, session.slots, continueRecording, recorder, deleteOrphanServerRecording, startRecordingForSlot, enqueuePendingStart, removePendingStart, setAudioState]
  );

  const handleRecordAgain = useCallback(
    (slotId: string) => {
      const slot = session.slots.find((s) => s.id === slotId);
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
    [session.slots, session.recorderBoundToSlotId, clearAudio, recorder, deleteOrphanServerRecording, deleteSlotDraft, user?.id]
  );

  const handleRemove = useCallback(
    (slotId: string) => {
      const slot = session.slots.find((s) => s.id === slotId);
      if (!slot) return;

      const hasRecording = slot.segments.length > 0 || !!slot.durable || isSlotActivelyRecording(slot);

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
                      try { await recorder.stop(); } catch {}
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
    [session.slots, session.recorderBoundToSlotId, recorder, removeSlot, unbindRecorder, deleteOrphanServerRecording, deleteSlotDraft, user?.id]
  );

  const slotHasLiveRecorder = useCallback(
    (slot: PatientSlot) =>
      isSlotActivelyRecording(slot) ||
      (session.recorderBoundToSlotId === slot.id &&
        (recorder.state === 'recording' || recorder.state === 'paused')),
    [session.recorderBoundToSlotId, recorder.state]
  );

  // -- Upload handlers --

  const uploadSlot = useCallback(
    async (slotArg: PatientSlot): Promise<string | null> => {
      // Re-read the latest slot from state. A stale closure (e.g. held by a
      // memoized child or an async caller) can pass in a slot object from
      // before the most recent `SET_DRAFT_IDS` dispatch — reading fresh here
      // guarantees we see `serverDraftId` / `draftMetadataDirty` / etc.
      const slot = sessionRef.current.slots.find((s) => s.id === slotArg.id) ?? slotArg;
      if (!canRecordAppointments(user?.role)) {
        showRecordPermissionAlert();
        return null;
      }
      if ((slot.segments.length === 0 && !slot.durable) || slot.uploadStatus === 'uploading') return null;
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
      activateKeepAwakeAsync(keepAwakeTag).catch(() => { /* best-effort */ });
      const attemptNumber = (uploadAttemptCountsRef.current.get(slot.id) ?? 0) + 1;
      uploadAttemptCountsRef.current.set(slot.id, attemptNumber);
      const currentSlots = sessionRef.current.slots;
      const slotIndex = currentSlots.findIndex((s) => s.id === slot.id);
      const slotCount = currentSlots.length;
      const durationSeconds = Math.round(
        slot.segments.reduce((sum, seg) => sum + (seg.duration ?? 0), 0)
      );
      const segmentCount = slot.segments.length;
      const uploadStartedAt = Date.now();
      const netState = networkStateForTelemetry();
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

      // Auto-split state — populated by the preflight block below if any
      // segment exceeds the 250 MB cap. Declared at function scope so the
      // catch + post-success cleanup can both see them.
      let segmentsForUpload = slot.segments;
      let splitTempDir: string | null = null;
      let splitTempUris: string[] = [];
      let uploadSizeBytes = 0;

      try {
        // ── Durable AAC upload (single audio.aac, no segments[], bypass split) ──
        if (slot.durable) {
          const durable = slot.durable;
          const uid = user?.id;
          if (!uid) {
            showRecordPermissionAlert();
            return null;
          }
          const manifest = await durableRecorder.getManifest({ userId: uid, recordingId: durable.recordingId });
          // A support-staff cross-user vault restore has no native manifest under
          // THIS user's scope, but the vault preserved a local audio.aac copy
          // (durable.recoveredAudioUri) that we upload directly. Native-manifest
          // ops (anchor/markUploaded/purge) are skipped for that path.
          const hasNativeManifest = !!manifest;
          const durableUri = manifest?.audioFile.uri ?? durable.recoveredAudioUri ?? null;
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
          const info = await getInfoAsync(durableUri);
          const durableSizeBytes = info.exists ? info.size ?? 0 : 0;
          if (!info.exists || durableSizeBytes === 0) {
            setUploadStatus(slot.id, 'error', { error: 'The recording audio was not found on this device.' });
            return null;
          }
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
            const override = await confirmSilentUpload();
            if (!override) {
              const silentErr = new Error(
                'This recording appears silent. Please verify microphone input and record again before uploading.',
              ) as Error & { uploadPhase?: 'silent_check' };
              silentErr.uploadPhase = 'silent_check';
              throw silentErr;
            }
          }

          // Upload ONLY the complete-ADTS-frame prefix. A crash can leave a torn
          // partial frame past the manifest's completeFrameBytes anchor; sending
          // the raw file would fail server-side ADTS validation. When the file is
          // longer than the anchor, stream the prefix into a temp .aac and upload
          // that; a clean stop has anchor === size so this is skipped. Only the
          // native-manifest path has a trustworthy anchor (a recovered vault copy
          // was already truncated at recovery time).
          let durableUploadUri = durableUri;
          let durablePrefixTempUri: string | null = null;
          const completeFrameBytes = manifest?.audioFile.completeFrameBytes ?? 0;
          if (hasNativeManifest && completeFrameBytes > 0 && completeFrameBytes < durableSizeBytes) {
            const tempUri = `${Paths.cache.uri}durable-upload-${durable.recordingId}.aac`;
            if (writeFilePrefix(durableUri, tempUri, completeFrameBytes)) {
              durableUploadUri = tempUri;
              durablePrefixTempUri = tempUri;
              breadcrumb('upload', 'durable_prefix_truncated', {
                file_bytes: durableSizeBytes,
                prefix_bytes: completeFrameBytes,
              });
            } else if (__DEV__) {
              // Best-effort: on failure fall back to the full file (server may
              // still accept it if the tail happened to be frame-aligned).
              console.error('[Record] durable prefix truncation failed; uploading full file');
            }
          }

          setUploadStatus(slot.id, 'uploading', { progress: 5 });
          let lastDurableProgress = 0;
          // Promote-in-place: reuse the death-surviving server draft. Dirty
          // metadata is sent with confirm-upload so metadata + status commit
          // atomically; if the server cannot apply it, uploadSlot fails closed.
          let durableUseExisting = slot.serverDraftId ?? slot.serverRecordingId ?? undefined;
          const durableConfirmMetadata =
            slot.serverDraftId && slot.draftMetadataDirty ? slot.formData : undefined;
          let durableResult;
          try {
            durableResult = await recordingsApi.createWithFile(
              slot.formData,
              durableUploadUri,
              'audio/aac',
              {
                fileName: 'recording.aac',
                // Deterministic key derived from the on-disk durable recordingId so
                // a retried create() after a kill reuses the same server row.
                idempotencyKey: `durable-${durable.recordingId}`,
                // Persist serverRecordingId into the manifest BEFORE the R2 PUT.
                // No-op for a recovered vault copy (no native manifest to anchor).
                onRecordingCreated: async (recordingId) => {
                  if (!hasNativeManifest) return;
                  await durableRecorder
                    .setServerRecordingId({ userId: uid, recordingId: durable.recordingId, serverRecordingId: recordingId })
                    .catch(() => {});
                },
                onUploadProgress: ({ percent }) => {
                  const now = Date.now();
                  if (now - lastDurableProgress >= 500) {
                    lastDurableProgress = now;
                    setUploadStatus(slot.id, 'uploading', { progress: Math.round(5 + (percent * 85) / 100) });
                  }
                },
                onR2Complete: (hint) => {
                  setUploadStatus(slot.id, 'uploading', {
                    progress: 95,
                    pendingConfirm: { recordingId: hint.recordingId, fileKey: hint.fileKey },
                  });
                },
                resume: slot.pendingConfirm ?? undefined,
                ...(durableUseExisting ? { existingRecordingId: durableUseExisting } : {}),
                ...(durableConfirmMetadata ? { confirmMetadata: durableConfirmMetadata } : {}),
                audioDurationSeconds: durableDurationSeconds,
                slotIndex,
              },
            );
          } finally {
            // Drop the truncated-prefix temp on both success and failure; the
            // original audio.aac (and its manifest) stay untouched for retry.
            if (durablePrefixTempUri) safeDeleteFile(durablePrefixTempUri);
          }

          completedUploadSlotIdsRef.current.add(slot.id);
          setUploadStatus(slot.id, 'success', { progress: 100, serverRecordingId: durableResult.id });
          recordSubmitAttempt(durableResult.id);

          // Post-success, strict order: write the uploaded marker FIRST, then
          // delete the draft, then (only if that succeeded) purge + tombstone.
          const confirmedAt = new Date().toISOString();
          if (hasNativeManifest) {
            await durableRecorder
              .markUploaded({ userId: uid, recordingId: durable.recordingId, confirmedUploadAt: confirmedAt })
              .catch(() => {});
          }
          // draftStorage.deleteDraft() is best-effort and SWALLOWS its own storage
          // failures (resolves without throwing), so a try/catch can't tell whether
          // the metadata was actually removed. VERIFY via getDraft — otherwise a
          // Keystore failure would leave the draft on disk while we purge the native
          // audio.aac, stranding a "Not Submitted" card whose recording is gone.
          const confirmDraftGone = async (): Promise<boolean> => {
            try {
              await draftStorage.deleteDraft(slot.id);
              await recoveryIntent.clearForDraftSlot(slot.id);
            } catch {
              return false;
            }
            const still = await draftStorage.getDraft(slot.id).catch(() => null);
            return still === null;
          };
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
          durableRecoveryStore.remove(durable.recordingId);

          const durableLatencyMs = Date.now() - uploadStartedAt;
          trackEvent({ name: 'durable_upload_confirmed', props: { recording_id: durableResult.id } });
          trackEvent({
            name: 'submit_succeeded',
            props: {
              slot_index: slotIndex,
              segment_count: 0,
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
          for (const seg of slot.segments) {
            const info = await getInfoAsync(seg.uri);
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
        const onR2Complete = (hint: {
          recordingId: string;
          fileKey: string;
          segmentKeys?: string[];
          segmentCount?: number;
        }) => {
          setUploadStatus(slot.id, 'uploading', {
            progress: 95,
            pendingConfirm: {
              recordingId: hint.recordingId,
              fileKey: hint.fileKey,
              segmentKeys: hint.segmentKeys,
              segmentCount: hint.segmentCount,
            },
          });
        };

        // If we'd reuse a server draft and the user edited formData after the
        // draft was created, send those edits in confirm-upload. The server
        // applies metadata + status in one transaction or rejects the confirm.
        let useExistingDraft = !!slot.serverDraftId;
        const serverDraftId = slot.serverDraftId;
        const confirmMetadata =
          useExistingDraft && serverDraftId && slot.draftMetadataDirty ? slot.formData : undefined;

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
              resume: slot.pendingConfirm ?? undefined,
              ...(useExistingDraft && serverDraftId ? { existingRecordingId: serverDraftId } : {}),
              ...(confirmMetadata ? { confirmMetadata } : {}),
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
              resume: slot.pendingConfirm ?? undefined,
              ...(useExistingDraft && serverDraftId ? { existingRecordingId: serverDraftId } : {}),
              ...(confirmMetadata ? { confirmMetadata } : {}),
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
        // Clean up local audio files now that they're safely on R2
        slot.segments.forEach((seg) => {
          safeDeleteFile(seg.uri);
        });
        // Also clean up any FFmpeg-split temp parts + their containing dir.
        for (const tempUri of splitTempUris) safeDeleteFile(tempUri);
        if (splitTempDir) safeDeleteDirectory(splitTempDir);
        // Clean up local draft after successful upload
        draftStorage.deleteDraft(slot.id).catch(() => {});
        recoveryIntent.clearForDraftSlot(slot.id).catch(() => {});

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
        // User explicitly cancelled the oversize confirm dialog: do not log,
        // do not capture, leave the slot in 'pending'. They can retry later.
        if (error instanceof UploadCancelledByUser) {
          setUploadStatus(slot.id, 'pending');
          if (splitTempDir) safeDeleteDirectory(splitTempDir);
          return null;
        }

        let msg: string;
        if (error instanceof TypeError && /network/i.test(error.message)) {
          msg = 'No internet connection. Please check your network and try again.';
        } else if (error instanceof Error) {
          msg = error.message;
        } else {
          msg = 'Upload failed. Please try again.';
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
            network_state: netState,
            latency_ms: latencyMs,
            ...failureSubmitDiagnostics,
          },
        });
        reportClientError({
          phase,
          severity: telemetrySeverity,
          errorCode,
          message: msg,
          recordingId: slot.serverDraftId ?? slot.serverRecordingId ?? undefined,
          slotIndex,
          segmentCount,
          durationSeconds,
          fileSizeBytes: uploadSizeBytes || undefined,
          networkState: netState,
          attemptNumber,
          submitContext: failureSubmitDiagnostics,
        });
        if (!isRecoverable) {
          captureException(error, {
            tags: {
              phase,
              error_code: errorCode,
              network_state: netState,
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
            },
          });
        }
        breadcrumb('upload', 'submit_failed', {
          slot_index: slotIndex,
          phase,
          error_code: errorCode,
          attempt_number: attemptNumber,
        });
        // Signal auto-stash eligibility to the submit handler. Two phases
        // qualify, both characterized by a dead network mid-submit that the
        // user can recover from by re-submitting once online:
        //   - r2_put: transient exhaustion after all 3 retries (Sentry
        //     REACT-NATIVE-4 fingerprint).
        //   - create_draft: fetch() throws `Network request failed` while
        //     POSTing the draft row or validating an existing serverDraftId
        //     (Sentry REACT-NATIVE-C fingerprint, multi-patient Submit-All on
        //     offline tablet).
        // presign / preflight / silence / confirm failures stay excluded —
        // those represent local-file / metering / server-side state problems
        // that won't resolve just by stashing and retrying when back online.
        if (isTransientUploadError(error)) {
          if (phase === 'r2_put') {
            autoStashableFailuresRef.current.set(slot.id, 'r2_put_dead_network');
          } else if (phase === 'create_draft') {
            autoStashableFailuresRef.current.set(slot.id, 'create_draft_dead_network');
          }
        }
        return null;
      } finally {
        uploadingSlotIdsRef.current.delete(slot.id);
        deactivateKeepAwake(keepAwakeTag).catch(() => { /* best-effort */ });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- netInfo read via networkStateForTelemetry closure; derivation is pure
    [setUploadStatus, dispatch, user?.id, user?.role]
  );

  // Phase 2 of autoSaveDraft — the network half. Patches an existing draft in
  // place, or creates a fresh one. Reads the slot from sessionRef to avoid
  // acting on a stale snapshot captured at schedule time. Guarded by the same
  // race refs as before so a Submit or completed upload during the await
  // aborts before leaving a ghost draft row behind.
  const syncServerDraft = useCallback(
    async (slotId: string, draftSlotId: string) => {
      try {
        if (!canRecordAppointments(user?.role)) return;
        const slot = sessionRef.current.slots.find((s) => s.id === slotId);
        if (!slot) return;
        if (completedUploadSlotIdsRef.current.has(slotId)) {
          draftStorage.deleteDraft(slotId).catch(() => {});
          recoveryIntent.clearForDraftSlot(slotId).catch(() => {});
          return;
        }
        if (!isConnected || submitIntentSlotIdsRef.current.has(slotId)) return;

        let serverId: string | null = null;
        if (slot.serverDraftId) {
          const outcome = await patchDraftMetadataWithRetry(slot.serverDraftId, slot.formData);
          if (outcome === 'success') {
            serverId = slot.serverDraftId;
          } else if (outcome === 'draft_missing') {
            // 404 from the server — the draft genuinely no longer exists
            // (e.g. deleted from another device). Fall through to fresh create.
            if (__DEV__) console.warn('[Record] syncServerDraft: draft missing on server, creating fresh', slot.serverDraftId);
          } else {
            // Keep draftMetadataDirty=true. A later Submit must either sync the
            // latest metadata or fail closed before promotion, even after restart.
            await draftStorage.markDraftMetadataDirty(slotId);
            dispatch({ type: 'MARK_DRAFT_METADATA_DIRTY', slotId });
            breadcrumb('draft', 'sync_server_draft_metadata_not_synced', {
              slot_id: slotId,
              outcome,
            });
            return;
          }

          if (completedUploadSlotIdsRef.current.has(slotId)) {
            draftStorage.deleteDraft(slotId).catch(() => {});
            recoveryIntent.clearForDraftSlot(slotId).catch(() => {});
            return;
          }
          if (submitIntentSlotIdsRef.current.has(slotId)) return;
        }

        if (!serverId) {
          if (submitIntentSlotIdsRef.current.has(slotId)) return;
          // A durable slot MUST create with a deterministic idempotency key
          // derived from its on-disk durable recordingId, so a later Submit
          // (which reuses `durable-${recordingId}`) promotes THIS row instead of
          // fresh-creating a duplicate if the app dies before updateServerDraftId
          // lands. Also persist serverRecordingId into the manifest as the
          // death-surviving anchor. Mirrors the submit path + usePendingDraftSync.
          const durableRecordingId = slot.durable?.recordingId;
          const result = durableRecordingId
            ? await recordingsApi.create(slot.formData, {
                isDraft: true,
                idempotencyKey: `durable-${durableRecordingId}`,
              })
            : await recordingsApi.create(slot.formData, { isDraft: true });
          serverId = result.id;
          if (durableRecordingId && user?.id) {
            await durableRecorder
              .setServerRecordingId({
                userId: user.id,
                recordingId: durableRecordingId,
                serverRecordingId: serverId,
              })
              .catch(() => {});
          }

          if (submitIntentSlotIdsRef.current.has(slotId) || completedUploadSlotIdsRef.current.has(slotId)) {
            deleteRecordingWithRetry(serverId, 'post_upload_local_cleanup').catch(() => {});
            if (completedUploadSlotIdsRef.current.has(slotId)) {
              draftStorage.deleteDraft(slotId).catch(() => {});
              recoveryIntent.clearForDraftSlot(slotId).catch(() => {});
            }
            return;
          }
        }

        dispatch({ type: 'SET_DRAFT_IDS', slotId, draftSlotId, serverDraftId: serverId });
        await draftStorage.updateServerDraftId(draftSlotId, serverId);
        invalidateRecordingCaches(queryClient, 'draft_changed');
      } catch (error) {
        const hadServerDraft = !!sessionRef.current.slots.find((s) => s.id === slotId)?.serverDraftId;
        if (hadServerDraft) {
          await draftStorage.markDraftMetadataDirty(slotId);
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
      if (!timer) return;
      clearTimeout(timer);
      pendingDraftTimersRef.current.delete(slotId);
      const slot = sessionRef.current.slots.find((s) => s.id === slotId);
      if (!slot || !slot.draftSlotId) return;
      await syncServerDraft(slotId, slot.draftSlotId);
    },
    [syncServerDraft]
  );

  const autoSaveDraft = useCallback(
    async (slot: PatientSlot) => {
      try {
        // Phase 1: persist the local draft (audio + metadata). Always runs
        // regardless of connectivity so the user can resume offline.
        const { draftSlotId, promotedSegments } = await draftStorage.saveDraft(slot);
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
          console.warn('[Record] segment-count mismatch in autoSaveDraft promotion',
            { input: slot.segments.length, promoted: promotedSegments.length });
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
        await recoveryIntent.save({
          userId: user?.id,
          draftSlotId,
          reason: recoveryReason,
        });
        invalidateRecordingCaches(queryClient, 'draft_changed');

        if (completedUploadSlotIdsRef.current.has(slot.id)) {
          deleteLocalSlotDraft(slot);
          return true;
        }

        if (!isConnected || submitIntentSlotIdsRef.current.has(slot.id)) return true;

        // Phase 2: server sync. Debounced so a user who immediately taps
        // Submit never writes a draft row to the server.
        scheduleDraftSync(slot.id, draftSlotId);
        return true;
      } catch (error) {
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
    },
    [deleteLocalSlotDraft, dispatch, isConnected, queryClient, scheduleDraftSync, user?.id]
  );

  autoSaveDraftRef.current = autoSaveDraft;

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

      session.slots.forEach((slot) => {
        deleteOrphanServerRecording(slot);
        deleteLocalSlotDraft(slot);
      });

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
      Alert.alert(
        'Saved for Later',
        "Your network was unstable, so we saved this for you. Open it from Saved Sessions and tap Resume once you're back online."
      );
      return true;
    },
    [
      stashSession,
      releaseResumedStashIfAny,
      resetSession,
      deleteOrphanServerRecording,
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

  const handleSubmitSingle = useCallback(
    (slotId: string) => {
      const slot = sessionRef.current.slots.find((s) => s.id === slotId);
      if (!slot) return;
      if (finishingDraftSlotId === slotId) {
        Alert.alert(
          'Saving Recording',
          'Please wait until the recording is saved before submitting.'
        );
        return;
      }
      if (!canRecordAppointments(user?.role)) {
        showRecordPermissionAlert();
        return;
      }
      if (slotHasLiveRecorder(slot)) {
        Alert.alert(
          'Finish Recording First',
          'Finish or discard the active recording segment before submitting this patient.'
        );
        return;
      }

      markSubmitIntent([slotId]);
      setSubmittingSlotId(slotId);
      setTotalSlotsToUpload(1);

      (async () => {
        try {
          const serverRecordingId = await uploadSlot(slot);
          if (serverRecordingId) {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
            invalidateRecordingCaches(queryClient, 'submit_success');

            // Check if other slots still have unsaved recordings (exclude already-uploaded slots)
            const otherSlotsWithRecordings = sessionRef.current.slots.some(
              (s) => s.id !== slotId && s.uploadStatus !== 'success' &&
                (s.segments.length > 0 || !!s.durable || s.audioState === 'recording' || s.audioState === 'paused')
            );

            if (otherSlotsWithRecordings) {
              // Stay on the record screen — uploaded slot already shows success badge.
              // Do NOT release the pinned stash here: remaining slots may still be
              // reading audio files from the stash directory. Release runs only
              // after the whole session is resolved.
            } else {
              releaseResumedStashIfAny();
              resetSession();
              router.push(`/recordings/${serverRecordingId}` as `/recordings/${string}`);
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
          setTotalSlotsToUpload(0);
        }
      })().catch(() => {
        clearSubmitIntent([slotId]);
        setSubmittingSlotId(null);
        setTotalSlotsToUpload(0);
      });
    },
    [clearSubmitIntent, finishingDraftSlotId, markSubmitIntent, recordSelectedSlotUploadNull, slotHasLiveRecorder, uploadSlot, queryClient, resetSession, router, releaseResumedStashIfAny, tryAutoStashOnNetworkDeath, user?.role]
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

    const recordedSlotsNeedingDetails = recordFirstEnabled
      ? []
      : sessionRef.current.slots.filter(
          (s) =>
            (s.segments.length > 0 || !!s.durable) &&
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
      (s) => (s.segments.length > 0 || !!s.durable) &&
        (recordFirstEnabled || slotHasRequiredSubmitFields(s)) &&
        s.uploadStatus !== 'success' &&
        s.uploadStatus !== 'uploading' &&
        !slotHasLiveRecorder(s)
    );

    if (slotsToUpload.length === 0) return;

    const slotIdsToUpload = slotsToUpload.map((slot) => slot.id);
    markSubmitIntent(slotIdsToUpload);
    setIsSubmittingAll(true);
    setTotalSlotsToUpload(slotsToUpload.length);
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

        if (allSuccess) {
          releaseResumedStashIfAny();
          resetSession();
          router.push({
            pathname: '/recordings',
            params: { submittedIds: submittedRecordingIds.join(',') },
          } as never);
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
        setTotalSlotsToUpload(0);
        try { netUnsub(); } catch { /* noop */ }
        setSessionActivity('idle');
      }
    })().catch(() => {
      clearSubmitIntent(slotIdsToUpload);
      setIsSubmittingAll(false);
      setSubmittingSlotId(null);
      setTotalSlotsToUpload(0);
      try { netUnsub(); } catch { /* noop */ }
      setSessionActivity('idle');
    });
  }, [clearSubmitIntent, finishingDraftSlotId, markSubmitIntent, recordFirstEnabled, recordSelectedSlotUploadNull, slotHasLiveRecorder, uploadSlot, queryClient, router, resetSession, releaseResumedStashIfAny, tryAutoStashOnNetworkDeath, user?.role]);

  const handleAddPatient = useCallback(() => {
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
        // Read sessionRef (not the closure-captured `session`): flushScheduledDraft
        // dispatches SET_DRAFT_IDS, which updates the ref synchronously but does
        // not update the closure variable. Passing `session` risks stashing the
        // pre-flush snapshot with a missing serverDraftId.
        const postFlushSession = sessionRef.current;
        const success = await stashSession(postFlushSession);
        if (success) {
          // The stashed form of the session does not persist pendingConfirm, so
          // any half-confirmed server recording is now unreachable. Best-effort
          // delete each one so they don't linger as orphaned 'uploading' rows.
          // Local auto-saved draft metadata/audio is removed because the stash
          // now owns the local files. The server draft row is intentionally
          // preserved via `serverDraftId` in the stash payload so resume ->
          // submit promotes the same draft in place.
          postFlushSession.slots.forEach((slot) => {
            deleteOrphanServerRecording(slot);
            deleteLocalSlotDraft(slot);
          });
          // The new stash supersedes the one we resumed from — release it so the
          // old SecureStore entry and audio dir don't linger. Done only after the
          // new stash has committed successfully, so the active session's data is
          // never orphaned between the two.
          releaseResumedStashIfAny();
          resetSession();
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          Alert.alert('Session Saved', 'Your recordings have been saved. You can resume them anytime from this screen.');
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
          const hasRecordings = postFlushSession.slots.some((s) => s.segments.length > 0 || !!s.durable);
          if (hasRecordings) {
            Alert.alert('Save Failed', 'Could not save your session. Your recordings are still here — please try again or submit them now.');
          }
        }
      } catch (error) {
        if (__DEV__) console.error('[Record] stash failed:', error);
        Alert.alert('Save Failed', 'Could not save your session. Your recordings are still here — please try again or submit them now.');
      } finally {
        setIsStashing(false);
      }
    })().catch(() => {
      setIsStashing(false);
    });
  }, [stashSession, resetSession, releaseResumedStashIfAny, deleteOrphanServerRecording, deleteLocalSlotDraft, flushScheduledDraft]);

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
    // If recorder is active, stop it first — the effect will trigger executeStash
    if (session.recorderBoundToSlotId && (recorder.state === 'recording' || recorder.state === 'paused')) {
      Alert.alert(
        'Save for Later?',
        'Your active recording will be saved. You can resume this session later to add more context.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Save',
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

    Alert.alert(
      'Save for Later?',
      'Your recordings will be saved. You can resume this session later to add more context.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Save', onPress: executeStash },
      ]
    );
  }, [session.recorderBoundToSlotId, recorder, executeStash]);

  const loadDraft = useCallback(
    async (slotId: string) => {
      try {
        const draft = await draftStorage.getDraft(slotId);
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
        // Validate all segment files still exist
        for (const seg of draft.segments) {
          if (!fileExists(seg.uri)) {
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
        // All files present — restore into session
        const restoredSlot: PatientSlot = {
          id: draft.slotId,
          formData: draft.formData,
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
          serverDraftId: draft.serverDraftId,
          // Fail closed after restart: if a local draft is attached to a server
          // draft, submit should send current formData with confirm-upload even
          // if an older build did not persist the dirty bit.
          draftMetadataDirty: draft.draftMetadataDirty || !!draft.serverDraftId,
          pendingConfirm: null,
        };
        restoreSession([restoredSlot]);
        recoveryIntent.clearForDraftSlot(draft.slotId).catch(() => {});
      } catch (error) {
        if (__DEV__) console.warn('[Record] loadDraft failed:', error);
        Alert.alert('Error', 'Could not load the draft recording.');
      }
    },
    [resetSession, restoreSession, router]
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
      if (s.draftSlotId) preserveIds.add(s.draftSlotId);
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

    // "Truly unsaved" = work that would actually be lost if we reset the
    // session: in-memory segments with no draft saved, or a live/paused
    // recorder. Drafted slots are durable on disk + server, so loading a
    // different draft doesn't lose them — we skip the warning dialog and
    // let the preserve list keep their rows intact.
    const trulyUnsaved = currentSlots.some(
      (s) =>
        (s.segments.length > 0 && !s.draftSlotId && s.uploadStatus !== 'success') ||
        // Durable slot (empty segments): count as unsaved whenever not uploaded so
        // loading another draft can't silently reset an unsubmitted durable slot.
        (!!s.durable && s.uploadStatus !== 'success') ||
        s.audioState === 'recording' ||
        s.audioState === 'paused'
    );

    if (trulyUnsaved) {
      Alert.alert(
        'Replace Current Session?',
        'You have unsaved recordings in progress. Loading this draft will replace them.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Load Draft',
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

  // Effect: check for pending drafts and update banner state
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
  }, [session, user?.id]);

  // Effect: on mount (once per user), sweep local drafts whose audio files
  // are missing on disk. Those are "zombie" drafts — they'll render as "Not
  // Submitted" on Home but `loadDraft` can never restore them. They happen
  // when an older client stashed a session before stash preserved
  // `serverDraftId` (the stash deleted the draft audio on commit). Deleting
  // the server row + local metadata clears them from the UI.
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    const cancelWork = scheduleNonUrgentWork('orphan_cleanup', async () => {
      const cleaned = await draftStorage
        .cleanupOrphaned((serverDraftId) => recordingsApi.delete(serverDraftId, { reason: 'orphan_draft_cleanup' }), {
          // Reconcile the legacy empty-server-linked branch before deleting any
          // server row (fail-closed offline so a just-uploaded row is never lost).
          getStatus: async (serverDraftId) => {
            try {
              const rec = await recordingsApi.get(serverDraftId);
              return (rec?.status as string | undefined) ?? null;
            } catch {
              return null;
            }
          },
          isOnline: isConnected !== false,
        })
        .catch(() => 0);
      if (!cancelled && cleaned > 0) {
        invalidateRecordingCaches(queryClient, 'draft_deleted');
      }
      // Sweep stale FFmpeg-split temp dirs from a previous session that may
      // have been force-quit mid-split. Live in-flight splits create their
      // own uniquely-timestamped subdir and are guarded by the orchestrator's
      // own try/catch — this only wipes leftovers.
      cleanupSplitTempDirs(user.id);
    }, 3_000);
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
    const cancelWork = scheduleNonUrgentWork('thirty_day_eviction', async () => {
      try {
        const getStatus = async (id: string): Promise<string | null> => {
          try {
            const rec = await recordingsApi.get(id);
            return rec?.status ?? null;
          } catch {
            return null;
          }
        };
        const draftResult = await draftStorage.evictExpired(
          { maxAgeDays: 30, warnAgeDays: 23, isOnline: online },
          getStatus
        );
        const stashResult = await stashStorage.evictExpired({ maxAgeDays: 30, warnAgeDays: 23 });

        const expiredDrafts = draftResult.expired;
        const expiredStashes = stashResult.expired;
        const totalExpired = expiredDrafts.length + expiredStashes.length;
        const totalExpiring = draftResult.expiring.length + stashResult.expiring.length;

        if (cancelled) return;
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
                    for (const draft of expiredDrafts) {
                      try {
                        if (draft.serverDraftId) {
                          await recordingsApi.delete(draft.serverDraftId, { reason: 'user_delete' }).catch(() => {});
                        }
                        await draftStorage.deleteDraft(draft.slotId);
                      } catch {
                        // best-effort
                      }
                    }
                    for (const stash of expiredStashes) {
                      try {
                        await deleteStash(stash.id);
                      } catch {
                        // best-effort
                      }
                    }
                    invalidateRecordingCaches(queryClient, 'draft_deleted');
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
    }, 4_000);
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

      if (hasUnsavedRecordings) {
        Alert.alert(
          'Replace Current Session?',
          'Your current recordings will be lost. Are you sure you want to resume the saved session?',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Replace',
              style: 'destructive',
              onPress: () => {
                (async () => {
                  await discardCurrentSession();
                  doResume();
                })().catch(() => {});
              },
            },
          ]
        );
      } else {
        doResume();
      }
    },
    [hasUnsavedRecordings, discardCurrentSession, resumeStashedSession, markResumed, restoreSession]
  );

  const handleDeleteStash = useCallback(
    (stashId: string) => {
      Alert.alert(
        'Delete Saved Session?',
        'Audio recordings will be permanently deleted. This cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
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
          // Segment set is about to change — the pendingConfirm (if any) no
          // longer matches the audio. Best-effort delete the orphan before
          // the reducer clears the hint.
          const editedSlot = sessionRef.current.slots.find((s) => s.id === result.slotId);
          if (editedSlot) deleteOrphanServerRecording(editedSlot);
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
    [session.slots, router, replaceAllSegments, deleteOrphanServerRecording]
  );

  // Show stash list when session is clean and stashes exist
  const showStashList = !stashesLoading && stashCount > 0 && !hasUnsavedRecordings;

  // Show stash button when there are unsaved recordings to stash
  const canStash =
    hasUnsavedRecordings && !isSubmittingAll && !isStashing && finishingDraftSlotId === null;
  const isAnyUploading = session.slots.some((s) => s.uploadStatus === 'uploading');

  // Upload overlay visibility
  const showOverlay = isSubmittingAll || submittingSlotId !== null || session.slots.some((s) => s.uploadStatus === 'uploading');

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
          recorder={recorder}
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
        />
      );
    },
    [
      session.recorderBoundToSlotId,
      session.slots.length,
      recorder,
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
                onPress={handleStashSession}
                disabled={isAtCapacity || isAnyUploading}
                loading={isStashing}
                accessibilityLabel="Save session for later"
              >
                {isAtCapacity ? 'Saved Full' : 'Save for Later'}
              </Button>
            </View>
          )}
        </View>
      </View>

      {/* Stashed Sessions */}
      {showStashList && (
        <View className="px-5 pb-2">
          <Text className="text-body-sm font-semibold text-content-secondary mb-2">
            Saved Sessions ({stashCount})
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
      {interruptionPendingResume && (
        <View
          className="mx-5 mb-2 px-3 py-3 bg-status-warning border-2 border-status-warning rounded-lg flex-row items-center"
          accessibilityLiveRegion="assertive"
          accessibilityRole="alert"
        >
          <View className="w-2 h-2 rounded-full bg-warning-500 mr-3" />
          <Text className="text-body-sm font-semibold text-status-warning flex-1">
            Recording paused for call — auto-resuming when you return.
          </Text>
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
        >
          {paginationText ? (
            <Text className="text-caption text-content-tertiary">{paginationText}</Text>
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
        visible={showOverlay}
        slots={session.slots}
        currentSlotId={submittingSlotId}
        totalSlotsToUpload={totalSlotsToUpload}
        isMulti={isSubmittingAll}
      />
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
