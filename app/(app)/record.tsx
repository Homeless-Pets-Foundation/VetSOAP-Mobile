import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, Alert, ActivityIndicator, Linking, useWindowDimensions, FlatList } from 'react-native';
import { useRouter } from 'expo-router';
import { usePreventRemove } from '@react-navigation/native';
import { useNavigation } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { Mic } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import * as FileSystem from 'expo-file-system';
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
} from 'expo-audio';
import { useAudioRecorder } from '../../src/hooks/useAudioRecorder';
import { useMultiPatientSession } from '../../src/hooks/useMultiPatientSession';
import { useResponsive } from '../../src/hooks/useResponsive';
import { useTemplates } from '../../src/hooks/useTemplates';
import { SafeAreaView } from 'react-native-safe-area-context';
import { recordingsApi } from '../../src/api/recordings';
import { PatientTabStrip } from '../../src/components/PatientTabStrip';
import { PatientSlotCard } from '../../src/components/PatientSlotCard';
import { SubmitPanel } from '../../src/components/SubmitPanel';
import { ScreenContainer } from '../../src/components/ui/ScreenContainer';
import { Button } from '../../src/components/ui/Button';
import type { PatientSlot } from '../../src/types/multiPatient';

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
    activeSlot,
    hasUnsavedRecordings,
    completedUnuploadedCount,
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
  } = useMultiPatientSession(defaultTemplate?.id);

  const [isSubmittingAll, setIsSubmittingAll] = useState(false);
  const pagerRef = useRef<FlatList>(null);
  const isScrollingRef = useRef(false);
  // Track pending slot for "stop A then start B" flow
  const pendingStartSlotRef = useRef<string | null>(null);
  // Ref for startRecordingForSlot to avoid hoisting issues in the effect
  const startRecordingRef = useRef<(slotId: string) => void>(() => {});
  // Guard: prevent the audio-capture effect from saving twice for the same stop
  const audioCaptureDoneRef = useRef(false);

  // Auto-select default template for first slot once templates load
  useEffect(() => {
    if (defaultTemplate && session.slots.length === 1 && !session.slots[0].formData.templateId) {
      updateForm(session.slots[0].id, 'templateId', defaultTemplate.id);
    }
  }, [defaultTemplate]);

  // Effect: capture audio URI when recorder transitions to stopped while bound to a slot
  useEffect(() => {
    if (recorder.state !== 'stopped') {
      // Reset guard when recorder leaves stopped state (e.g. after reset → new recording)
      audioCaptureDoneRef.current = false;
      return;
    }
    if (recorder.audioUri && session.recorderBoundToSlotId && !audioCaptureDoneRef.current) {
      audioCaptureDoneRef.current = true;
      saveAudio(session.recorderBoundToSlotId, recorder.audioUri, recorder.duration);
      unbindRecorder();

      // If there's a pending slot to start recording on, do it now
      if (pendingStartSlotRef.current) {
        const nextSlotId = pendingStartSlotRef.current;
        pendingStartSlotRef.current = null;
        recorder.resetWithoutDelete();
        setTimeout(() => {
          startRecordingRef.current(nextSlotId);
        }, 250);
      }
    }
  }, [recorder.state, recorder.audioUri]);

  // Navigation guard: warn before leaving with unsaved recordings
  usePreventRemove(hasUnsavedRecordings && !isSubmittingAll, ({ data }) => {
    Alert.alert(
      'Discard Recordings?',
      'You have unsaved recordings. Leaving will discard them.',
      [
        { text: 'Stay', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => {
            // Clean up all segment audio files
            session.slots.forEach((slot) => {
              slot.segments.forEach((seg) => {
                FileSystem.deleteAsync(seg.uri, { idempotent: true }).catch(() => {});
              });
            });
            navigation.dispatch(data.action);
          },
        },
      ]
    );
  });

  // Sync pager with active index
  useEffect(() => {
    if (!isScrollingRef.current && pagerRef.current) {
      pagerRef.current.scrollToIndex({
        index: session.activeIndex,
        animated: true,
      });
    }
  }, [session.activeIndex]);

  // Auto-pause when swiping away from recording slot
  const handleScrollEnd = useCallback(
    (e: { nativeEvent: { contentOffset: { x: number } } }) => {
      isScrollingRef.current = false;
      const newIndex = Math.round(e.nativeEvent.contentOffset.x / screenWidth);
      const clampedIndex = Math.max(0, Math.min(newIndex, session.slots.length - 1));

      if (clampedIndex !== session.activeIndex) {
        // Haptic feedback on swipe between patients
        Haptics.selectionAsync().catch(() => {});

        // If leaving a recording slot, auto-pause
        if (session.recorderBoundToSlotId && recorder.state === 'recording') {
          const boundSlot = session.slots.find((s) => s.id === session.recorderBoundToSlotId);
          if (boundSlot) {
            (async () => {
              try {
                await recorder.pause();
                setAudioState(session.recorderBoundToSlotId!, 'paused');
              } catch {
                // If pause fails, try to stop — the effect will save the audio
                try {
                  await recorder.stop();
                } catch {}
              }
            })().catch(() => {});
          }
        }
        setActiveIndex(clampedIndex);
      }
    },
    [session.activeIndex, session.slots.length, session.recorderBoundToSlotId, recorder.state, screenWidth]
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
          const msg =
            error instanceof Error && error.message.toLowerCase().includes('permission')
              ? 'Microphone permission is required. Please grant access in Settings.'
              : 'Could not start recording. Please check that your device has a microphone and it is not in use by another app.';
          Alert.alert('Microphone Error', msg);
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
          Alert.alert('Recording Error', 'Failed to pause recording.');
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
          Alert.alert('Recording Error', 'Failed to resume recording.');
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
                  FileSystem.deleteAsync(seg.uri, { idempotent: true }).catch(() => {});
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
                      FileSystem.deleteAsync(seg.uri, { idempotent: true }).catch(() => {});
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
    async (slot: PatientSlot): Promise<boolean> => {
      if (slot.segments.length === 0 || slot.uploadStatus === 'success' || slot.uploadStatus === 'uploading') return true;

      setUploadStatus(slot.id, 'uploading', { progress: 5 });
      try {
        let result;
        if (slot.segments.length === 1) {
          // Single segment: use existing single-file upload
          result = await recordingsApi.createWithFile(
            slot.formData,
            slot.segments[0].uri,
            'audio/x-m4a',
            {
              onUploadProgress: ({ percent }) => {
                setUploadStatus(slot.id, 'uploading', {
                  progress: Math.round(5 + (percent * 85) / 100),
                });
              },
            }
          );
        } else {
          // Multi-segment: upload all segments
          result = await recordingsApi.createWithSegments(
            slot.formData,
            slot.segments,
            'audio/x-m4a',
            {
              onUploadProgress: ({ percent }) => {
                setUploadStatus(slot.id, 'uploading', {
                  progress: Math.round(5 + (percent * 85) / 100),
                });
              },
            }
          );
        }
        setUploadStatus(slot.id, 'success', {
          progress: 100,
          serverRecordingId: result.id,
        });
        return true;
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Upload failed. Please try again.';
        setUploadStatus(slot.id, 'error', { progress: 0, error: msg });
        return false;
      }
    },
    [setUploadStatus]
  );

  const handleSubmitSingle = useCallback(
    (slotId: string) => {
      const slot = session.slots.find((s) => s.id === slotId);
      if (!slot) return;

      (async () => {
        const success = await uploadSlot(slot);
        if (success) {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          queryClient.invalidateQueries({ queryKey: ['recordings'] }).catch(() => {});
        }
      })().catch(() => {});
    },
    [session.slots, uploadSlot, queryClient]
  );

  const handleSubmitAll = useCallback(() => {
    const slotsToUpload = session.slots.filter(
      (s) => s.segments.length > 0 && s.uploadStatus !== 'success' && s.uploadStatus !== 'uploading'
    );

    if (slotsToUpload.length === 0) return;

    setIsSubmittingAll(true);
    (async () => {
      try {
        let allSuccess = true;
        // Sequential uploads to avoid network saturation
        for (const slot of slotsToUpload) {
          const success = await uploadSlot(slot);
          if (!success) allSuccess = false;
        }

        Haptics.notificationAsync(
          allSuccess
            ? Haptics.NotificationFeedbackType.Success
            : Haptics.NotificationFeedbackType.Warning
        ).catch(() => {});

        queryClient.invalidateQueries({ queryKey: ['recordings'] }).catch(() => {});

        if (allSuccess) {
          // Navigate to recordings list
          router.push('/(app)/recordings');
        } else {
          Alert.alert(
            'Some Uploads Failed',
            'Some recordings failed to upload. You can retry the failed ones.'
          );
        }
      } finally {
        setIsSubmittingAll(false);
      }
    })().catch(() => {
      setIsSubmittingAll(false);
    });
  }, [session.slots, uploadSlot, queryClient, router]);

  const handleAddPatient = useCallback(() => {
    addSlot();
    // Scroll to new slot on next frame
    setTimeout(() => {
      if (pagerRef.current) {
        pagerRef.current.scrollToEnd({ animated: true });
      }
    }, 50);
  }, [addSlot]);

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
    <SafeAreaView className="flex-1 bg-stone-50">
      {/* Header */}
      <View className="px-5 pt-3 pb-2 bg-stone-50">
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
        renderItem={renderSlotCard}
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
