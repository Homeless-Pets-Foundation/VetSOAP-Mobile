import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, Alert, ActivityIndicator, Linking, useWindowDimensions, FlatList } from 'react-native';
import { useRouter, useNavigation } from 'expo-router';
import { usePreventRemove } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { Mic } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { safeDeleteFile } from '../../../src/lib/fileOps';
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
} from 'expo-audio';
import { useAudioRecorder } from '../../../src/hooks/useAudioRecorder';
import { useMultiPatientSession } from '../../../src/hooks/useMultiPatientSession';
import { useStashedSessions } from '../../../src/hooks/useStashedSessions';
import { useResponsive } from '../../../src/hooks/useResponsive';
import { useTemplates } from '../../../src/hooks/useTemplates';
import { SafeAreaView } from 'react-native-safe-area-context';
import { recordingsApi } from '../../../src/api/recordings';
import { audioEditorBridge } from '../../../src/lib/audioEditorBridge';
import { PatientTabStrip } from '../../../src/components/PatientTabStrip';
import { PatientSlotCard } from '../../../src/components/PatientSlotCard';
import { SubmitPanel } from '../../../src/components/SubmitPanel';
import { StashedSessionCard } from '../../../src/components/StashedSessionCard';
import { UploadOverlay } from '../../../src/components/UploadOverlay';
import { ScreenContainer } from '../../../src/components/ui/ScreenContainer';
import { Button } from '../../../src/components/ui/Button';
import type { PatientSlot } from '../../../src/types/multiPatient';

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
          accessibilityLabel="Grant microphone access"
        >
          Grant Microphone Access
        </Button>
      </View>
    </ScreenContainer>
  );
}

function RecordingSession() {
  const router = useRouter();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
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
  } = useMultiPatientSession(defaultTemplate?.id);

  const {
    stashes,
    stashCount,
    isAtCapacity,
    stashSession,
    resumeSession: resumeStashedSession,
    confirmResume,
    deleteStash,
  } = useStashedSessions();

  const [isSubmittingAll, setIsSubmittingAll] = useState(false);
  const [submittingSlotId, setSubmittingSlotId] = useState<string | null>(null);
  const [totalSlotsToUpload, setTotalSlotsToUpload] = useState(0);
  const [isStashing, setIsStashing] = useState(false);
  const pagerRef = useRef<FlatList>(null);
  const isScrollingRef = useRef(false);
  const swipeChangeRef = useRef(false);
  // Track pending slot for "stop A then start B" flow
  const pendingStartSlotRef = useRef<string | null>(null);
  // Track pending stash for "stop recorder then stash" flow
  const pendingStashRef = useRef(false);
  // Ref for startRecordingForSlot to avoid hoisting issues in the effect
  const startRecordingRef = useRef<(slotId: string) => void>(() => {});
  // Guard: prevent the audio-capture effect from saving twice for the same stop
  const audioCaptureDoneRef = useRef(false);

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
    if (recorder.audioUri && session.recorderBoundToSlotId && !audioCaptureDoneRef.current) {
      audioCaptureDoneRef.current = true;
      saveAudio(session.recorderBoundToSlotId, recorder.audioUri, recorder.duration);
      unbindRecorder();

      // If there's a pending stash, just reset the recorder here.
      // Don't call executeStash() yet — saveAudio dispatch hasn't been processed,
      // so `session` still has 0 segments. A separate effect fires executeStash
      // on the next render after SAVE_AUDIO updates the session state.
      if (pendingStashRef.current) {
        recorder.resetWithoutDelete();
      } else if (pendingStartSlotRef.current) {
        // If there's a pending slot to start recording on, do it now
        const nextSlotId = pendingStartSlotRef.current;
        pendingStartSlotRef.current = null;
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
      } else if (pendingStartSlotRef.current) {
        const nextSlotId = pendingStartSlotRef.current;
        pendingStartSlotRef.current = null;
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
  }, [recorder.state, recorder.audioUri]);

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
            // Clean up all segment audio files
            session.slots.forEach((slot) => {
              slot.segments.forEach((seg) => {
                safeDeleteFile(seg.uri);
              });
            });
            // Clean up any in-flight recording that was never saved to a slot
            if (recorder.audioUri) {
              safeDeleteFile(recorder.audioUri);
            }
            navigation.dispatch(data.action);
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
                    pendingStartSlotRef.current = slotId;
                    (async () => {
                      try {
                        await recorder.stop();
                      } catch {
                        pendingStartSlotRef.current = null;
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
            pendingStartSlotRef.current = slotId;
            (async () => {
              try {
                await recorder.stop();
              } catch {
                pendingStartSlotRef.current = null;
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
    (slotId: string) => {
      (async () => {
        try {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
          // The effect above will capture audioUri and call saveAudio + unbindRecorder
          // when recorder.state transitions to 'stopped'
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
      continueRecording(slotId);
    },
    [session.recorderBoundToSlotId, continueRecording, recorder]
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
    [session.slots, session.recorderBoundToSlotId, clearAudio, recorder]
  );

  const handleRemove = useCallback(
    (slotId: string) => {
      const slot = session.slots.find((s) => s.id === slotId);
      if (!slot) return;

      const hasRecording = slot.segments.length > 0 || slot.audioState === 'recording' || slot.audioState === 'paused';

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
                      try { await recorder.stop(); } catch {}
                      unbindRecorder();
                      recorder.reset();
                    }
                    slot.segments.forEach((seg) => {
                      safeDeleteFile(seg.uri);
                    });
                    removeSlot(slotId);
                  } catch {}
                })().catch(() => {});
              },
            },
          ]
        );
      } else {
        removeSlot(slotId);
      }
    },
    [session.slots, session.recorderBoundToSlotId, recorder, removeSlot, unbindRecorder]
  );

  // -- Upload handlers --

  const uploadSlot = useCallback(
    async (slot: PatientSlot): Promise<string | null> => {
      if (slot.segments.length === 0 || slot.uploadStatus === 'uploading') return null;
      if (slot.uploadStatus === 'success') return slot.serverRecordingId ?? null;

      setUploadStatus(slot.id, 'uploading', { progress: 5 });
      try {
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

        let result;
        if (slot.segments.length === 1) {
          // Single segment: use existing single-file upload
          result = await recordingsApi.createWithFile(
            slot.formData,
            slot.segments[0].uri,
            'audio/x-m4a',
            { onUploadProgress }
          );
        } else {
          // Multi-segment: upload all segments
          result = await recordingsApi.createWithSegments(
            slot.formData,
            slot.segments,
            'audio/x-m4a',
            { onUploadProgress }
          );
        }
        setUploadStatus(slot.id, 'success', {
          progress: 100,
          serverRecordingId: result.id,
        });
        // Clean up local audio files now that they're safely on R2
        slot.segments.forEach((seg) => {
          safeDeleteFile(seg.uri);
        });
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
        return null;
      }
    },
    [setUploadStatus]
  );

  const handleSubmitSingle = useCallback(
    (slotId: string) => {
      const slot = session.slots.find((s) => s.id === slotId);
      if (!slot) return;

      setSubmittingSlotId(slotId);
      setTotalSlotsToUpload(1);

      (async () => {
        try {
          const serverRecordingId = await uploadSlot(slot);
          if (serverRecordingId) {
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
            queryClient.invalidateQueries({ queryKey: ['recordings'] }).catch(() => {});

            // Check if other slots still have unsaved recordings (exclude already-uploaded slots)
            const otherSlotsWithRecordings = session.slots.some(
              (s) => s.id !== slotId && s.uploadStatus !== 'success' &&
                (s.segments.length > 0 || s.audioState === 'recording' || s.audioState === 'paused')
            );

            if (otherSlotsWithRecordings) {
              // Stay on the record screen — uploaded slot already shows success badge
            } else {
              resetSession();
              router.push(`/recordings/${serverRecordingId}` as `/recordings/${string}`);
            }
          }
        } finally {
          setSubmittingSlotId(null);
          setTotalSlotsToUpload(0);
        }
      })().catch(() => {
        setSubmittingSlotId(null);
        setTotalSlotsToUpload(0);
      });
    },
    [session.slots, uploadSlot, queryClient, resetSession, router]
  );

  const handleSubmitAll = useCallback(() => {
    const slotsToUpload = session.slots.filter(
      (s) => s.segments.length > 0 && s.uploadStatus !== 'success' && s.uploadStatus !== 'uploading'
    );

    if (slotsToUpload.length === 0) return;

    setIsSubmittingAll(true);
    setTotalSlotsToUpload(slotsToUpload.length);

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
          resetSession();
          router.push('/recordings');
        } else {
          Alert.alert(
            'Some Uploads Failed',
            'Some recordings failed to upload. You can retry the failed ones.'
          );
        }
      } finally {
        setIsSubmittingAll(false);
        setSubmittingSlotId(null);
        setTotalSlotsToUpload(0);
      }
    })().catch(() => {
      setIsSubmittingAll(false);
      setSubmittingSlotId(null);
      setTotalSlotsToUpload(0);
    });
  }, [session.slots, uploadSlot, queryClient, router, resetSession]);

  const handleAddPatient = useCallback(() => {
    addSlot();
  }, [addSlot]);

  // -- Stash handlers --

  const executeStash = useCallback(() => {
    setIsStashing(true);
    (async () => {
      try {
        const success = await stashSession(session);
        if (success) {
          resetSession();
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          Alert.alert('Session Saved', 'Your recordings have been saved. You can resume them anytime from this screen.');
        } else {
          // stashSession returns false if no slots have audio or max stashes reached.
          // The session is NOT reset, so recordings are still in the active session.
          Alert.alert('Save Failed', 'Could not save your session. Your recordings are still here — please try again or submit them now.');
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
  }, [session, stashSession, resetSession]);

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

  const handleResumeStash = useCallback(
    (stashId: string) => {
      const doResume = () => {
        (async () => {
          try {
            const slots = await resumeStashedSession(stashId);
            if (slots) {
              restoreSession(slots);
              // Remove from SecureStore AFTER restoreSession dispatches.
              // If the app crashes before this, the stash survives for retry.
              confirmResume(stashId).catch(() => {});
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
                // Clean up current session audio files before restoring
                session.slots.forEach((slot) => {
                  slot.segments.forEach((seg) => {
                    safeDeleteFile(seg.uri);
                  });
                });
                doResume();
              },
            },
          ]
        );
      } else {
        doResume();
      }
    },
    [hasUnsavedRecordings, session.slots, resumeStashedSession, confirmResume, restoreSession]
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

      // Snapshot segments before navigating — avoids stale closure if session changes while editing
      const originalSegments = slot.segments.map((s) => ({ uri: s.uri, duration: s.duration }));

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
          replaceAllSegments(result.slotId, result.segments);
        }
      });

      audioEditorBridge.setInput({ slotId, segments: originalSegments });

      router.push('/(app)/audio-editor' as any);
    },
    [session.slots, router, replaceAllSegments]
  );

  // Show stash list when session is clean and stashes exist
  const showStashList = stashCount > 0 && !hasUnsavedRecordings;

  // Show stash button when there are unsaved recordings to stash
  const canStash = hasUnsavedRecordings && !isSubmittingAll && !isStashing;
  const isAnyUploading = session.slots.some((s) => s.uploadStatus === 'uploading');

  // Upload overlay visibility
  const showOverlay = isSubmittingAll || session.slots.some((s) => s.uploadStatus === 'uploading');

  // Pagination indicator
  const paginationText =
    session.slots.length > 6
      ? `${session.activeIndex + 1} of ${session.slots.length}`
      : null;

  const recorderBusy =
    session.recorderBoundToSlotId !== null &&
    (recorder.state === 'recording' || recorder.state === 'paused');

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
          onUpdateForm={(field, value) => updateForm(item.id, field, value)}
          onStart={() => handleStart(item.id)}
          onPause={() => handlePause(item.id)}
          onResume={() => handleResume(item.id)}
          onStop={() => handleStop(item.id)}
          onRecordAgain={() => handleRecordAgain(item.id)}
          onContinueRecording={() => handleContinueRecording(item.id)}
          onRemove={() => handleRemove(item.id)}
          onSubmitSingle={() => handleSubmitSingle(item.id)}
          onEditRecording={() => handleEditRecording(item.id)}
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
      updateForm,
      handleStart,
      handlePause,
      handleResume,
      handleStop,
      handleRecordAgain,
      handleContinueRecording,
      handleRemove,
      handleSubmitSingle,
      handleEditRecording,
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
