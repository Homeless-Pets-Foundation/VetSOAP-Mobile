import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, Alert, ActivityIndicator, Linking, useWindowDimensions, FlatList, AppState } from 'react-native';
import type { AppStateStatus } from 'react-native';
import { useRouter, useNavigation, useLocalSearchParams } from 'expo-router';
import { usePreventRemove } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { Mic } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { safeDeleteFile, fileExists } from '../../../src/lib/fileOps';
import NetInfo, { useNetInfo } from '@react-native-community/netinfo';
import { draftStorage } from '../../../src/lib/draftStorage';
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
} from 'expo-audio';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as audioFocus from '../../../modules/captivet-audio-focus';
import { useAudioRecorder } from '../../../src/hooks/useAudioRecorder';
import { useAuth } from '../../../src/hooks/useAuth';
import { useMultiPatientSession } from '../../../src/hooks/useMultiPatientSession';
import { useStashedSessions } from '../../../src/hooks/useStashedSessions';
import { useResponsive } from '../../../src/hooks/useResponsive';
import { useTemplates } from '../../../src/hooks/useTemplates';
import { SafeAreaView } from 'react-native-safe-area-context';
import { recordingsApi, getUploadPhase } from '../../../src/api/recordings';
import { deleteRecordingWithRetry, patchDraftMetadataWithRetry } from '../../../src/lib/retryableCleanup';
import { trackEvent, type NetworkState } from '../../../src/lib/analytics';
import { breadcrumb, captureException } from '../../../src/lib/monitoring';
import { reportClientError } from '../../../src/api/telemetry';
import { DRAFT_DEBOUNCE_MS } from '../../../src/config';
import { audioEditorBridge } from '../../../src/lib/audioEditorBridge';
import { recordSubmitAttempt } from '../../../src/lib/submitTiming';
import { setSessionActivity } from '../../../src/lib/sessionActivity';
import { PatientTabStrip } from '../../../src/components/PatientTabStrip';
import { PatientSlotCard } from '../../../src/components/PatientSlotCard';
import { SubmitPanel } from '../../../src/components/SubmitPanel';
import { StashedSessionCard } from '../../../src/components/StashedSessionCard';
import { UploadOverlay } from '../../../src/components/UploadOverlay';
import { ScreenContainer } from '../../../src/components/ui/ScreenContainer';
import { Button } from '../../../src/components/ui/Button';
import type { PatientSlot } from '../../../src/types/multiPatient';
import type { CreateRecording } from '../../../src/types';

function PermissionGate({ onGranted }: { onGranted: () => void }) {
  const { scale } = useResponsive();
  const [requesting, setRequesting] = useState(false);

  const handleRequest = () => {
    setRequesting(true);
    requestRecordingPermissionsAsync()
      .then(({ granted, canAskAgain }) => {
        if (granted) {
          onGranted();
        } else if (!canAskAgain) {
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
          className="bg-brand-50 rounded-full justify-center items-center mb-6"
          style={{ width: scale(96), height: scale(96) }}
        >
          <Mic color="#0d8775" size={scale(40)} />
        </View>
        <Text className="text-display font-bold text-stone-900 text-center mb-3">
          Microphone Access
        </Text>
        <Text className="text-body text-stone-500 text-center mb-8">
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

function isSlotActivelyRecording(slot: PatientSlot): boolean {
  return slot.audioState === 'recording' || slot.audioState === 'paused';
}

function hasSilentAudioOnly(slot: PatientSlot): boolean {
  if (slot.segments.length === 0) return false;
  // Use peakMetering stored at record-time (sampled every 500ms) instead of running
  // FFmpeg volumedetect on the entire file. On A7 Lite, FFmpeg decoding a 45-minute
  // recording takes 10-20s and blocks the upload modal from appearing.
  // Fail open: if any segment lacks metering data, assume not silent.
  return slot.segments.every(
    (seg) => seg.peakMetering !== undefined && seg.peakMetering <= -20
  );
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
  const { user } = useAuth();
  const recorder = useAudioRecorder();
  const { width: screenWidth } = useWindowDimensions();
  const { templates, defaultTemplate, isLoading: templatesLoading } = useTemplates();

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
    bindRecorder,
    unbindRecorder,
    setUploadStatus,
    resetSession,
    restoreSession,
    replaceAllSegments,
    dispatch,
  } = useMultiPatientSession(defaultTemplate?.id);

  // Always-current mirror of `session`. Callbacks that need fresh state at
  // invocation time read from `sessionRef.current` and drop `session.*` from
  // their deps. This makes handler identity stable, which lets memoized
  // children (PatientSlotCard) keep them across renders without hiding state
  // updates behind stale closures. The assignment runs on every render before
  // any of our effects/handlers fire.
  const sessionRef = useRef(session);
  sessionRef.current = session;

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
  const deleteOrphanServerRecording = useCallback((slot: PatientSlot) => {
    const recordingId = slot.pendingConfirm?.recordingId;
    if (!recordingId) return;
    recordingsApi.delete(recordingId).catch(() => {});
  }, []);

  /** Delete only the local auto-saved draft metadata/audio for a slot. */
  const deleteLocalSlotDraft = useCallback((slot: PatientSlot) => {
    draftStorage.deleteDraft(slot.id).catch(() => {});
  }, []);

  /**
   * Delete the auto-saved draft tied to a slot — both the local SecureStore
   * entry and the server Recording row (if one was created). Used when the
   * user discards a session: the recording is no longer useful and would
   * otherwise linger as a ghost "Not Submitted" row on Home plus PHI on disk.
   */
  const deleteSlotDraft = useCallback((slot: PatientSlot) => {
    deleteLocalSlotDraft(slot);
    if (slot.serverDraftId && slot.uploadStatus !== 'success') {
      recordingsApi.delete(slot.serverDraftId).catch(() => {});
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
  // Ref for startRecordingForSlot to avoid hoisting issues in the effect
  const startRecordingRef = useRef<(slotId: string) => void>(() => {});
  const autoSaveDraftRef = useRef<(slot: PatientSlot) => Promise<void>>(async () => {});
  // Guard: prevent the audio-capture effect from saving twice for the same stop
  const audioCaptureDoneRef = useRef(false);
  // Guard: track which slot IDs are actively uploading to prevent double-submission
  // across React render batches (useRef is synchronous; useState is not).
  const uploadingSlotIdsRef = useRef<Set<string>>(new Set());
  // Guard: a slot marked for submission may still finish its deferred local draft save,
  // but it must not create a new server-side draft row while upload is in flight.
  const submitIntentSlotIdsRef = useRef<Set<string>>(new Set());
  // Guard: if upload wins the race against deferred local draft persistence, auto-save
  // must immediately clean up the late draft instead of leaving it behind locally.
  const completedUploadSlotIdsRef = useRef<Set<string>>(new Set());
  // Per-slot timers for debounced server-draft creation. Server POST
  // /api/recordings {isDraft:true} runs after DRAFT_DEBOUNCE_MS; if the user
  // taps Submit first, the timer is cancelled so no draft row ever exists to
  // orphan. On stash, pending timers are flushed synchronously so the Home
  // "Not Submitted" card still appears. Empty map = debounce disabled or no
  // pending syncs.
  const pendingDraftTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Suppress the next stopped-audio capture when the current segment is being discarded.
  const skipNextAudioCaptureRef = useRef(false);

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
    };
  }, []);

  // Auto-select default template for first slot once templates load
  useEffect(() => {
    if (defaultTemplate && session.slots.length === 1 && !session.slots[0].formData.templateId) {
      updateForm(session.slots[0].id, 'templateId', defaultTemplate.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only run when defaultTemplate loads, not on every slot/form change
  }, [defaultTemplate]);

  // Effect: capture audio URI when recorder transitions to stopped while bound to a slot
  useEffect(() => {
    let timerId: ReturnType<typeof setTimeout> | null = null;

    if (recorder.state !== 'stopped') {
      // Reset guard when recorder leaves stopped state (e.g. after reset → new recording)
      audioCaptureDoneRef.current = false;
      return () => { if (timerId) clearTimeout(timerId); };
    }
    if (skipNextAudioCaptureRef.current && !audioCaptureDoneRef.current) {
      audioCaptureDoneRef.current = true;
      skipNextAudioCaptureRef.current = false;
      unbindRecorder();
      recorder.reset();
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
  }, [recorder.state, recorder.audioUri, recorder.duration, recorder.maxMetering, saveAudio, buildPersistedSlot]);

  // Consistency guard: fix orphaned paused/recording states when recorder ownership changes
  useEffect(() => {
    session.slots.forEach((slot) => {
      if (slot.id === session.recorderBoundToSlotId) return;
      if (slot.audioState === 'recording') {
        setAudioState(slot.id, slot.segments.length > 0 ? 'stopped' : 'idle');
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- guard runs only when recorder ownership changes, reading slots is intentionally from current render
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
  useEffect(() => {
    const sub = audioFocus.addListener((event) => {
      if (event.type === 'loss') {
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

  // Hold the audio-focus listener only while a slot is actively recording or
  // paused, so we don't preempt music / voice apps when no clinical session
  // is in progress.
  useEffect(() => {
    const isActive = recorder.state === 'recording' || recorder.state === 'paused';
    if (isActive) {
      audioFocus.startMonitoring().catch(() => {});
    } else {
      audioFocus.stopMonitoring().catch(() => {});
    }
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
      // owned by expo-audio until the user taps Finish.
      const slotsToPersist = sessionRef.current.slots.filter(
        (slot) => slot.segments.length > 0 && slot.uploadStatus !== 'success'
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
        safeDeleteFile(seg.uri);
      });
      // Best-effort delete any server recording left mid-confirm — the user is
      // abandoning this session entirely.
      deleteOrphanServerRecording(slot);
      // Also delete the auto-saved draft (local + server) so the discarded
      // recording doesn't linger as a "Not Submitted" row on Home — unless
      // the caller asked us to keep it (e.g. resume-from-Home is about to
      // load that draft and would otherwise read a freshly-deleted key).
      if (!slot.draftSlotId || !preserve.has(slot.draftSlotId)) {
        deleteSlotDraft(slot);
      }
    });

    // Release the pinned stash (if any) so the SecureStore entry and audio dir
    // are fully cleaned up. Must run before resetSession — after reset the
    // segment refs are gone, but releaseResumedStash works off the stored id.
    releaseResumedStashIfAny();

    resetSession();
  }, [session.slots, session.recorderBoundToSlotId, recorder, unbindRecorder, resetSession, releaseResumedStashIfAny, deleteOrphanServerRecording, deleteSlotDraft, cancelScheduledDraft]);

  // Navigation guard: only active when there are truly unsaved recordings (not yet uploaded)
  const unsavedCount = session.slots.filter(
    (s) => (s.segments.length > 0 && s.uploadStatus !== 'success') ||
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

  // Auto-pause when swiping away from a recording slot
  const handleScrollEnd = useCallback(
    (e: { nativeEvent: { contentOffset: { x: number } } }) => {
      isScrollingRef.current = false;
      const newIndex = Math.round(e.nativeEvent.contentOffset.x / screenWidth);
      const clampedIndex = Math.max(0, Math.min(newIndex, session.slots.length - 1));

      if (clampedIndex !== session.activeIndex) {
        // Haptic feedback on swipe between patients
        Haptics.selectionAsync().catch(() => {});

        // If leaving a recording slot, auto-pause so user can resume with one tap
        if (session.recorderBoundToSlotId && recorder.state === 'recording') {
          (async () => {
            try {
              await recorder.pause();
              setAudioState(session.recorderBoundToSlotId!, 'paused');
            } catch {
              // pause() rethrew after internal cleanup — try to stop as fallback
              try { await recorder.stop(); } catch {}
              // The audio-capture effect will save the segment if stop succeeded
            }
          })().catch(() => {});
        }
        swipeChangeRef.current = true;
        setActiveIndex(clampedIndex);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recorder and setActiveIndex accessed via refs/stable dispatch
    [session.activeIndex, session.slots.length, session.recorderBoundToSlotId, recorder.state, screenWidth, setAudioState]
  );

  const handleScrollBegin = useCallback(() => {
    isScrollingRef.current = true;
  }, []);

  // -- Recording handlers --

  const handleStart = useCallback(
    (slotId: string) => {
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
    [session.recorderBoundToSlotId, session.slots, recorder]
  );

  const startRecordingForSlot = useCallback(
    (slotId: string) => {
      (async () => {
        try {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
          bindRecorder(slotId);
          await recorder.start();
          setAudioState(slotId, 'recording');
        } catch (error) {
          unbindRecorder();
          const errMsg = error instanceof Error ? error.message.toLowerCase() : '';
          const msg = errMsg.includes('permission')
            ? 'Microphone permission is required. Please grant access in Settings.'
            : errMsg.includes('not ready')
              ? 'The recorder is still finishing a previous recording. Please try again in a moment.'
              : 'Could not start recording. Please check that your device has a microphone and it is not in use by another app.';
          Alert.alert('Recording Error', msg);
        }
      })().catch(() => {});
    },
    [recorder, bindRecorder, unbindRecorder, setAudioState]
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
    (_slotId: string) => {
      (async () => {
        try {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
          await recorder.stop();
        } catch {
          Alert.alert('Recording Error', 'Failed to stop recording.');
        }
      })().catch(() => {});
    },
    [recorder]
  );

  const handleContinueRecording = useCallback(
    (slotId: string) => {
      if (!session.recorderBoundToSlotId || session.recorderBoundToSlotId === slotId) {
        recorder.resetWithoutDelete();
      }
      const slot = session.slots.find((s) => s.id === slotId);
      if (slot) deleteOrphanServerRecording(slot);
      continueRecording(slotId);
    },
    [session.recorderBoundToSlotId, session.slots, continueRecording, recorder, deleteOrphanServerRecording]
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
                  safeDeleteFile(seg.uri);
                });
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
    [session.slots, session.recorderBoundToSlotId, clearAudio, recorder, deleteOrphanServerRecording, deleteSlotDraft]
  );

  const handleRemove = useCallback(
    (slotId: string) => {
      const slot = session.slots.find((s) => s.id === slotId);
      if (!slot) return;

      const hasRecording = slot.segments.length > 0 || isSlotActivelyRecording(slot);

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
                      safeDeleteFile(seg.uri);
                    });
                    deleteOrphanServerRecording(slot);
                    // Slot is about to disappear — delete its draft row + local
                    // audio so it doesn't surface as "Not Submitted" on Home.
                    deleteSlotDraft(slot);
                    removeSlot(slotId);
                  } catch {}
                })().catch(() => {});
              },
            },
          ]
        );
      } else {
        deleteOrphanServerRecording(slot);
        deleteSlotDraft(slot);
        removeSlot(slotId);
      }
    },
    [session.slots, session.recorderBoundToSlotId, recorder, removeSlot, unbindRecorder, deleteOrphanServerRecording, deleteSlotDraft]
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
      if (slot.segments.length === 0 || slot.uploadStatus === 'uploading') return null;
      if (slot.uploadStatus === 'success') return slot.serverRecordingId ?? null;
      // Synchronous ref guard — prevents a second concurrent upload of the same slot
      // during the window between button tap and React state update disabling the button.
      if (uploadingSlotIdsRef.current.has(slot.id)) return null;
      uploadingSlotIdsRef.current.add(slot.id);
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
      const slotIndex = sessionRef.current.slots.findIndex((s) => s.id === slot.id);
      const durationSeconds = Math.round(
        slot.segments.reduce((sum, seg) => sum + (seg.duration ?? 0), 0)
      );
      const segmentCount = slot.segments.length;
      const uploadStartedAt = Date.now();
      const netState = networkStateForTelemetry();

      trackEvent({
        name: 'submit_attempted',
        props: {
          slot_index: slotIndex,
          segment_count: segmentCount,
          duration_s: durationSeconds,
          recording_id: slot.serverDraftId ?? slot.serverRecordingId ?? undefined,
          attempt_number: attemptNumber,
          network_state: netState,
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
      });

      try {
        if (hasSilentAudioOnly(slot)) {
          const silentError = new Error(
            'This recording appears silent. Please verify microphone input and record again before uploading.'
          ) as Error & { uploadPhase?: 'silent_check' };
          silentError.uploadPhase = 'silent_check';
          throw silentError;
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
        // draft was created, flush the edits to the server. We retry transient
        // failures and ONLY fall back to fresh-create when the draft is
        // definitively gone (404). For any other failure mode — including
        // retries-exhausted — we keep the draft id and promote it via
        // existingRecordingId, even if that means the final recording carries
        // slightly stale metadata. A duplicate "Not Submitted" row is a
        // worse user experience than one recording with a 10-character diff
        // in the patient name, and the server-side replacedAt backstop would
        // then have nothing to clean up.
        let useExistingDraft = !!slot.serverDraftId;
        const serverDraftId = slot.serverDraftId;
        if (useExistingDraft && serverDraftId && slot.draftMetadataDirty) {
          const outcome = await patchDraftMetadataWithRetry(serverDraftId, slot.formData);
          if (outcome === 'success') {
            dispatch({ type: 'CLEAR_DRAFT_DIRTY', slotId: slot.id });
          } else if (outcome === 'draft_missing') {
            // Server has no such draft anymore — only path forward is a
            // fresh create. No orphan to leave behind.
            useExistingDraft = false;
          }
          // 'not_draft' + 'transient_failure' both fall through: keep
          // existingRecordingId. confirm-upload accepts either 'draft' or
          // 'uploading' status, so a partially-promoted row is still usable.
        }

        let result;
        if (slot.segments.length === 1) {
          // Single segment: use existing single-file upload
          result = await recordingsApi.createWithFile(
            slot.formData,
            slot.segments[0].uri,
            'audio/x-m4a',
            {
              onUploadProgress,
              onR2Complete,
              resume: slot.pendingConfirm ?? undefined,
              ...(useExistingDraft && serverDraftId ? { existingRecordingId: serverDraftId } : {}),
              audioDurationSeconds: durationSeconds,
              slotIndex,
            }
          );
        } else {
          // Multi-segment: upload all segments
          result = await recordingsApi.createWithSegments(
            slot.formData,
            slot.segments,
            'audio/x-m4a',
            {
              onUploadProgress,
              onR2Complete,
              resume: slot.pendingConfirm ?? undefined,
              ...(useExistingDraft && serverDraftId ? { existingRecordingId: serverDraftId } : {}),
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
        // Clean up local draft after successful upload
        draftStorage.deleteDraft(slot.id).catch(() => {});

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
        // win over phase so trial/billing errors stay legible.
        const errorObj = error as Error & { code?: string; status?: number };
        const errorCode =
          (errorObj?.code && String(errorObj.code)) ||
          (errorObj?.status ? `HTTP_${errorObj.status}` : phase.toUpperCase());

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
          },
        });
        reportClientError({
          phase,
          severity: 'error',
          errorCode,
          message: msg,
          recordingId: slot.serverDraftId ?? slot.serverRecordingId ?? undefined,
          slotIndex,
          segmentCount,
          durationSeconds,
          networkState: netState,
          attemptNumber,
        });
        captureException(error, {
          tags: {
            phase,
            error_code: errorCode,
            network_state: netState,
            has_existing_draft: String(!!slot.serverDraftId),
          },
          extra: {
            slot_index: slotIndex,
            attempt_number: attemptNumber,
            segment_count: segmentCount,
            duration_s: durationSeconds,
            latency_ms: latencyMs,
            recording_id: slot.serverDraftId ?? slot.serverRecordingId ?? null,
          },
        });
        breadcrumb('upload', 'submit_failed', {
          slot_index: slotIndex,
          phase,
          error_code: errorCode,
          attempt_number: attemptNumber,
        });
        return null;
      } finally {
        uploadingSlotIdsRef.current.delete(slot.id);
        deactivateKeepAwake(keepAwakeTag).catch(() => { /* best-effort */ });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- netInfo read via networkStateForTelemetry closure; derivation is pure
    [setUploadStatus, dispatch]
  );

  // Phase 2 of autoSaveDraft — the network half. Patches an existing draft in
  // place, or creates a fresh one. Reads the slot from sessionRef to avoid
  // acting on a stale snapshot captured at schedule time. Guarded by the same
  // race refs as before so a Submit or completed upload during the await
  // aborts before leaving a ghost draft row behind.
  const syncServerDraft = useCallback(
    async (slotId: string, draftSlotId: string) => {
      try {
        const slot = sessionRef.current.slots.find((s) => s.id === slotId);
        if (!slot) return;
        if (completedUploadSlotIdsRef.current.has(slotId)) {
          draftStorage.deleteDraft(slotId).catch(() => {});
          return;
        }
        if (!isConnected || submitIntentSlotIdsRef.current.has(slotId)) return;

        let serverId: string | null = null;
        if (slot.serverDraftId) {
          const outcome = await patchDraftMetadataWithRetry(slot.serverDraftId, slot.formData);
          if (outcome === 'success' || outcome === 'transient_failure' || outcome === 'not_draft') {
            // Keep the existing draft id. For 'transient_failure' + 'not_draft'
            // the metadata may be stale, but the row still exists and Submit
            // will promote it in place — strictly better than creating a
            // duplicate. 'success' is the happy path.
            serverId = slot.serverDraftId;
          } else if (outcome === 'draft_missing') {
            // 404 from the server — the draft genuinely no longer exists
            // (e.g. deleted from another device). Fall through to fresh create.
            if (__DEV__) console.warn('[Record] syncServerDraft: draft missing on server, creating fresh', slot.serverDraftId);
          }

          if (completedUploadSlotIdsRef.current.has(slotId)) {
            draftStorage.deleteDraft(slotId).catch(() => {});
            return;
          }
          if (submitIntentSlotIdsRef.current.has(slotId)) return;
        }

        if (!serverId) {
          if (submitIntentSlotIdsRef.current.has(slotId)) return;
          const result = await recordingsApi.create(slot.formData, { isDraft: true });
          serverId = result.id;

          if (submitIntentSlotIdsRef.current.has(slotId) || completedUploadSlotIdsRef.current.has(slotId)) {
            deleteRecordingWithRetry(serverId).catch(() => {});
            if (completedUploadSlotIdsRef.current.has(slotId)) {
              draftStorage.deleteDraft(slotId).catch(() => {});
            }
            return;
          }
        }

        dispatch({ type: 'SET_DRAFT_IDS', slotId, draftSlotId, serverDraftId: serverId });
        await draftStorage.updateServerDraftId(draftSlotId, serverId);
        queryClient.invalidateQueries({ queryKey: ['recordings'] }).catch(() => {});
      } catch (error) {
        if (__DEV__) console.warn('[Record] syncServerDraft failed:', error);
      }
    },
    [dispatch, isConnected, queryClient]
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
        const draftSlotId = await draftStorage.saveDraft(slot);
        // Preserve the existing serverDraftId here — the server draft (if any)
        // still represents this slot's recording. Nulling it would orphan the
        // server row on every stop/continue cycle.
        dispatch({
          type: 'SET_DRAFT_IDS',
          slotId: slot.id,
          draftSlotId,
          serverDraftId: slot.serverDraftId ?? null,
        });

        if (completedUploadSlotIdsRef.current.has(slot.id)) {
          draftStorage.deleteDraft(slot.id).catch(() => {});
          return;
        }

        if (!isConnected || submitIntentSlotIdsRef.current.has(slot.id)) return;

        // Phase 2: server sync. Debounced so a user who immediately taps
        // Submit never writes a draft row to the server.
        scheduleDraftSync(slot.id, draftSlotId);
      } catch (error) {
        // Draft save is best-effort — never surface errors to the user.
        // The recording is still in session state and can still be submitted.
        if (__DEV__) console.warn('[Record] autoSaveDraft failed:', error);
      }
    },
    [dispatch, isConnected, scheduleDraftSync]
  );

  autoSaveDraftRef.current = autoSaveDraft;

  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      const previousState = appStateRef.current;
      appStateRef.current = nextState;

      if (
        previousState === 'active' &&
        (nextState === 'inactive' || nextState === 'background')
      ) {
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
    if (pendingDraftSlotIdRef.current && !session.recorderBoundToSlotId) {
      const slotId = pendingDraftSlotIdRef.current;
      pendingDraftSlotIdRef.current = null;
      const slot = session.slots.find((s) => s.id === slotId);
      if (slot && slot.segments.length > 0) {
        autoSaveDraft(slot).catch(() => {});
      }
    }
  }, [session, autoSaveDraft]);

  const handleSubmitSingle = useCallback(
    (slotId: string) => {
      const slot = sessionRef.current.slots.find((s) => s.id === slotId);
      if (!slot) return;
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
            queryClient.invalidateQueries({ queryKey: ['recordings'] }).catch(() => {});

            // Check if other slots still have unsaved recordings (exclude already-uploaded slots)
            const otherSlotsWithRecordings = sessionRef.current.slots.some(
              (s) => s.id !== slotId && s.uploadStatus !== 'success' &&
                (s.segments.length > 0 || s.audioState === 'recording' || s.audioState === 'paused')
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
    [clearSubmitIntent, markSubmitIntent, slotHasLiveRecorder, uploadSlot, queryClient, resetSession, router, releaseResumedStashIfAny]
  );

  const handleSubmitAll = useCallback(() => {
    if (sessionRef.current.slots.some(slotHasLiveRecorder)) {
      Alert.alert(
        'Finish Active Recordings',
        'Finish or discard all active recording segments before submitting all patients.'
      );
      return;
    }

    const slotsToUpload = sessionRef.current.slots.filter(
      (s) => s.segments.length > 0 &&
        s.uploadStatus !== 'success' &&
        s.uploadStatus !== 'uploading' &&
        !slotHasLiveRecorder(s)
    );

    if (slotsToUpload.length === 0) return;

    const slotIdsToUpload = slotsToUpload.map((slot) => slot.id);
    markSubmitIntent(slotIdsToUpload);
    setIsSubmittingAll(true);
    setTotalSlotsToUpload(slotsToUpload.length);

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
        // Sequential uploads to avoid network saturation
        for (const slot of slotsToUpload) {
          setSubmittingSlotId(slot.id);
          const recordingId = await uploadSlot(slot);
          if (!recordingId) allSuccess = false;
        }

        Haptics.notificationAsync(
          allSuccess
            ? Haptics.NotificationFeedbackType.Success
            : Haptics.NotificationFeedbackType.Warning
        ).catch(() => {});

        queryClient.invalidateQueries({ queryKey: ['recordings'] }).catch(() => {});

        if (allSuccess) {
          releaseResumedStashIfAny();
          resetSession();
          router.push('/recordings');
        } else {
          Alert.alert(
            'Some Uploads Failed',
            'Some recordings failed to upload. You can retry the failed ones.'
          );
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
  }, [clearSubmitIntent, markSubmitIntent, slotHasLiveRecorder, uploadSlot, queryClient, router, resetSession, releaseResumedStashIfAny]);

  const handleAddPatient = useCallback(() => {
    addSlot();
  }, [addSlot]);

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
          const hasRecordings = postFlushSession.slots.some((s) => s.segments.length > 0);
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
                      recordingsApi.delete(draft.serverDraftId).catch(() => {});
                    }
                    draftStorage.deleteDraft(slotId).catch(() => {});
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
          audioUri: draft.segments.at(-1)?.uri ?? null,
          audioDuration: draft.audioDuration,
          uploadStatus: 'pending',
          uploadProgress: 0,
          uploadError: null,
          serverRecordingId: null,
          draftSlotId: draft.slotId,
          serverDraftId: draft.serverDraftId,
          draftMetadataDirty: false,
          pendingConfirm: null,
        };
        restoreSession([restoredSlot]);
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
    draftStorage.listDrafts().then((drafts) => {
      setHasPendingDrafts(drafts.some((d) => d.pendingSync));
    }).catch(() => {});
  }, [session]);

  // Effect: sync pending drafts when network becomes available
  useEffect(() => {
    if (!user?.id) return;
    const unsubscribe = NetInfo.addEventListener((state: any) => {
      if (state.isConnected) {
        draftStorage.syncPending(user.id, (formData) => recordingsApi.create(formData, { isDraft: true })).catch(() => {});
      }
    });
    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [user?.id]);

  // Effect: on mount (once per user), sweep local drafts whose audio files
  // are missing on disk. Those are "zombie" drafts — they'll render as "Not
  // Submitted" on Home but `loadDraft` can never restore them. They happen
  // when an older client stashed a session before stash preserved
  // `serverDraftId` (the stash deleted the draft audio on commit). Deleting
  // the server row + local metadata clears them from the UI.
  useEffect(() => {
    if (!user?.id) return;
    draftStorage
      .cleanupOrphaned((serverDraftId) => recordingsApi.delete(serverDraftId))
      .then((cleaned) => {
        if (cleaned > 0) {
          queryClient.invalidateQueries({ queryKey: ['recordings'] }).catch(() => {});
        }
      })
      .catch(() => {});
  }, [user?.id, queryClient]);

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
      if (!slot || slot.segments.length === 0) {
        Alert.alert('No Recording', 'Please record audio before editing.');
        return;
      }

      // Snapshot segments before navigating — avoids stale closure if session changes while editing.
      // Preserve peakMetering so the silent-audio guard (hasSilentAudioOnly) still works for
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
            if (!newUris.has(seg.uri)) {
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
  const canStash = hasUnsavedRecordings && !isSubmittingAll && !isStashing;
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
  const hasActiveRecording = session.slots.some(slotHasLiveRecorder);

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
          templates={templates}
          templatesLoading={templatesLoading}
          width={screenWidth}
          onUpdateForm={(field, value) => handleUpdateForm(item.id, field, value)}
          onStart={() => handleStart(item.id)}
          onPause={() => handlePause(item.id)}
          onResume={() => handleResume(item.id)}
          onStop={() => handleStop(item.id)}
          onRecordAgain={() => handleRecordAgain(item.id)}
          onContinueRecording={() => handleContinueRecording(item.id)}
          onRemove={() => handleRemove(item.id)}
          onSubmitSingle={() => handleSubmitSingle(item.id)}
          onEditRecording={() => handleEditRecording(item.id)}
          submitBlockedByLiveRecording={slotHasLiveRecorder(item)}
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
    <SafeAreaView className="flex-1 bg-stone-50">
      {/* Header */}
      <View className="px-5 pt-3 pb-2 bg-stone-50">
        <View className="flex-row justify-between items-start">
          <View className="flex-1">
            <Text
              className="text-display font-bold text-stone-900"
              accessibilityRole="header"
            >
              Record Appointment
            </Text>
            <Text className="text-body text-stone-500 mt-1">
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
          <Text className="text-body-sm font-semibold text-stone-600 mb-2">
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
        <View className="mx-5 mb-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg flex-row items-center">
          <Text className="text-body-sm text-amber-700 flex-1">
            Draft recording pending upload — connect to Wi-Fi to sync
          </Text>
        </View>
      )}

      {/* Interruption Banner — call/Siri/headphones interrupted recording.
          Stays visible from the moment the partial segment is saved until
          AppState returns to 'active' and recording auto-resumes. */}
      {interruptionPendingResume && (
        <View
          className="mx-5 mb-2 px-3 py-3 bg-orange-100 border-2 border-orange-400 rounded-lg flex-row items-center"
          accessibilityLiveRegion="assertive"
          accessibilityRole="alert"
        >
          <View className="w-2 h-2 rounded-full bg-orange-500 mr-3" />
          <Text className="text-body-sm font-semibold text-orange-800 flex-1">
            Recording paused for call — auto-resuming when you return.
          </Text>
        </View>
      )}

      {/* Patient Tab Strip */}
      <View className="px-3 pb-1">
        <PatientTabStrip
          slots={session.slots}
          activeIndex={session.activeIndex}
          onSelectIndex={(index) => {
            setActiveIndex(index);
          }}
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
          className="items-center py-2 bg-stone-50"
          accessibilityRole="adjustable"
          accessibilityLabel={`Patient ${session.activeIndex + 1} of ${session.slots.length}`}
          accessibilityLiveRegion="polite"
        >
          {paginationText ? (
            <Text className="text-caption text-stone-400">{paginationText}</Text>
          ) : (
            <View className="flex-row gap-1.5">
              {session.slots.map((slot, i) => (
                <View
                  key={slot.id}
                  className={`w-2 h-2 rounded-full ${
                    i === session.activeIndex ? 'bg-brand-500' : 'bg-stone-300'
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
  const [permissionStatus, setPermissionStatus] = useState<'checking' | 'granted' | 'denied'>('checking');

  useEffect(() => {
    getRecordingPermissionsAsync()
      .then(({ granted }) => {
        setPermissionStatus(granted ? 'granted' : 'denied');
      })
      .catch(() => {
        setPermissionStatus('denied');
      });
  }, []);

  if (permissionStatus === 'checking') {
    return (
      <ScreenContainer>
        <View className="flex-1 justify-center items-center">
          <ActivityIndicator size="large" color="#0d8775" />
        </View>
      </ScreenContainer>
    );
  }

  if (permissionStatus === 'denied') {
    return <PermissionGate onGranted={() => setPermissionStatus('granted')} />;
  }

  return <RecordingSession />;
}
