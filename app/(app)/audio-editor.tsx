import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, Alert, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { usePreventRemove, useFocusEffect } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, Play, Pause, SkipBack, SkipForward } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import { useAnimatedReaction, runOnJS } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { safeDeleteFile } from '../../src/lib/fileOps';
import { useAudioPlayback } from '../../src/hooks/useAudioPlayback';
import { audioEditorBridge } from '../../src/lib/audioEditorBridge';
import { trimAudio, concatenateAudio, extractWaveformPeaks } from '../../src/lib/ffmpeg';
import { audioTempFiles } from '../../src/lib/audioTempFiles';
import { WaveformEditor } from '../../src/components/WaveformEditor';
import { Button } from '../../src/components/ui/Button';
import type { AudioSegment } from '../../src/types/multiPatient';

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Isolated time display component. Subscribes to the Reanimated shared value
 * and only triggers a React re-render when the displayed second changes (~1x/sec),
 * instead of every 100ms like the full screen would.
 */
function PlaybackTimeDisplay({
  currentTimeSV,
  duration,
}: {
  currentTimeSV: SharedValue<number>;
  duration: number;
}) {
  const [displayTime, setDisplayTime] = useState(0);

  useAnimatedReaction(
    () => Math.floor(currentTimeSV.value),
    (currentSecond, previousSecond) => {
      if (currentSecond !== previousSecond) {
        runOnJS(setDisplayTime)(currentSecond);
      }
    }
  );

  return (
    <Text className="text-center text-body text-stone-500 mb-1">
      {formatTime(displayTime)} / {formatTime(duration)}
    </Text>
  );
}

export default function AudioEditorScreen() {
  const navigation = useNavigation();
  const router = useRouter();

  // Bridge input — re-read each time the screen gains focus (Tab screens stay mounted)
  const [input, setInput] = useState(() => audioEditorBridge.getInput());
  const slotId = input?.slotId ?? '';

  const [segments, setSegments] = useState<AudioSegment[]>(
    () => input?.segments ?? []
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [peaks, setPeaks] = useState<Map<number, number[]>>(new Map());
  const [peaksLoading, setPeaksLoading] = useState<Set<number>>(new Set());
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [isTrimming, setIsTrimming] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [peakErrors, setPeakErrors] = useState<Set<number>>(new Set());
  // Track whether we emitted trimmed segments — if so, skip temp file cleanup on unmount
  const savedResultRef = useRef(false);
  const [isConcatenating, setIsConcatenating] = useState(false);
  // Bumped each time the screen opens with new input — triggers concatenation effect
  const [sessionKey, setSessionKey] = useState(0);
  const initialSegmentCountRef = useRef(input?.segments.length ?? 0);

  const playback = useAudioPlayback();
  const { seekTo, pause, play, toggle, loadSource, isLoaded, isPlaying, currentTimeSV, currentTimeRef } = playback;

  // Re-read bridge input when screen regains focus (Tab screens stay mounted between visits)
  useFocusEffect(
    useCallback(() => {
      const bridgeInput = audioEditorBridge.getInput();
      if (!bridgeInput) return; // No new input — screen was focused without a new edit request
      if (__DEV__) console.log('[Editor] focus: new input for slot', bridgeInput.slotId, bridgeInput.segments.length, 'segs');
      setInput(bridgeInput);
      setSegments(bridgeInput.segments);
      setSelectedIndex(0);
      setPeaks(new Map());
      setPeaksLoading(new Set());
      setPeakErrors(new Set());
      setTrimStart(0);
      setTrimEnd(0);
      setIsTrimming(false);
      setHasChanges(false);
      savedResultRef.current = false;
      initialSegmentCountRef.current = bridgeInput.segments.length;
      setSessionKey((k) => k + 1);
    }, [])
  );

  // Auto-concatenate multiple segments into one when a new editing session starts
  useEffect(() => {
    if (initialSegmentCountRef.current <= 1) return;

    setIsConcatenating(true);
    const segmentUris = segments.map((s) => s.uri);
    const segmentCount = initialSegmentCountRef.current;
    const mergedPeakMetering = segments.reduce(
      (max, segment) => typeof segment.peakMetering === 'number' && segment.peakMetering > max
        ? segment.peakMetering
        : max,
      -160
    );
    (async () => {
      try {
        await audioTempFiles.ensureDir();
        const outputPath = audioTempFiles.getConcatOutputPath();
        const result = await concatenateAudio(segmentUris, outputPath);
        setSegments([{
          uri: result.uri,
          duration: result.duration,
          peakMetering: mergedPeakMetering > -160 ? mergedPeakMetering : undefined,
        }]);
        setSelectedIndex(0);
        setHasChanges(true);
        Alert.alert('Segments Merged', `${segmentCount} recording segments have been combined into one.`);
      } catch (error) {
        if (__DEV__) console.error('[Editor] concatenation failed:', error);
        Alert.alert('Note', 'Could not merge segments. You can edit each segment individually.');
      } finally {
        setIsConcatenating(false);
      }
    })().catch(() => {
      setIsConcatenating(false);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);

  // Selected segment
  const selectedSegment = segments[selectedIndex] ?? null;

  // Load audio source when segment changes
  const selectedUri = selectedSegment?.uri;
  const selectedDuration = selectedSegment?.duration ?? 0;
  const loadSourceRef = useRef(loadSource);
  loadSourceRef.current = loadSource;
  useEffect(() => {
    if (selectedUri) {
      loadSourceRef.current(selectedUri).catch(() => {});
      setTrimStart(0);
      setTrimEnd(selectedDuration);
    }
  }, [selectedUri, selectedDuration]);

  // Extract waveform peaks for selected segment
  // We use refs for peaks/peaksLoading checks to avoid re-triggering when they update
  const peaksRef = useRef(peaks);
  peaksRef.current = peaks;
  const peaksLoadingRef = useRef(peaksLoading);
  peaksLoadingRef.current = peaksLoading;

  useEffect(() => {
    if (!selectedUri) return;
    if (peaksRef.current.has(selectedIndex)) return;
    if (peaksLoadingRef.current.has(selectedIndex)) return;

    const index = selectedIndex;
    setPeaksLoading((prev) => new Set(prev).add(index));

    (async () => {
      try {
        const peakData = await extractWaveformPeaks(selectedUri, 150);
        setPeaks((prev) => new Map(prev).set(index, peakData));
      } catch (error) {
        if (__DEV__) console.error('[Editor] peak extraction failed:', error);
        setPeakErrors((prev) => new Set(prev).add(index));
      } finally {
        setPeaksLoading((prev) => {
          const next = new Set(prev);
          next.delete(index);
          return next;
        });
      }
    })().catch(() => {});
  }, [selectedIndex, selectedUri]);

  // Navigation guard for unsaved changes
  usePreventRemove(hasChanges, ({ data }) => {
    Alert.alert(
      'Discard Changes?',
      'Your trim changes have not been applied. Discard them?',
      [
        { text: 'Keep Editing', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => {
            audioEditorBridge.emitResult(null);
            navigation.dispatch(data.action);
          },
        },
      ]
    );
  });

  // Cleanup temp files on unmount — but only if user discarded (not if they saved trimmed segments)
  useEffect(() => {
    return () => {
      if (!savedResultRef.current) {
        audioTempFiles.cleanupAll();
      }
    };
  }, []);

  const handleTrimChange = useCallback((start: number, end: number) => {
    setTrimStart(start);
    setTrimEnd(end);
  }, []);

  const handleSeek = useCallback(
    (seconds: number) => {
      seekTo(seconds).catch(() => {});
    },
    [seekTo]
  );

  const handleSkipBack = useCallback(() => {
    seekTo(Math.max(0, (currentTimeRef.current ?? 0) - 10)).catch(() => {});
  }, [seekTo, currentTimeRef]);

  const handleSkipForward = useCallback(() => {
    const maxTime = selectedSegment?.duration ?? 0;
    seekTo(Math.min(maxTime, (currentTimeRef.current ?? 0) + 10)).catch(() => {});
  }, [seekTo, currentTimeRef, selectedSegment?.duration]);

  // Preview: play only the trimmed region
  const [isPreviewMode, setIsPreviewMode] = useState(false);

  const handlePreview = useCallback(() => {
    setIsPreviewMode(true);
    seekTo(trimStart).then(() => {
      play();
    }).catch(() => {});
  }, [seekTo, play, trimStart]);

  // Stop playback at trim end during preview (with 0.15s tolerance for timing jitter).
  // Uses setInterval to check currentTimeRef so this only runs during the brief preview period
  // and avoids re-rendering the full screen on every 100ms position update.
  useEffect(() => {
    if (!isPreviewMode) return;
    // Clear preview flag if user paused manually before the interval fires
    if (!isPlaying) {
      setIsPreviewMode(false);
      return;
    }
    const interval = setInterval(() => {
      const time = currentTimeRef.current ?? 0;
      if (time >= trimEnd - 0.15 && trimEnd < selectedDuration) {
        pause();
        setIsPreviewMode(false);
      }
    }, 100);
    return () => clearInterval(interval);
  }, [isPreviewMode, isPlaying, trimEnd, selectedDuration, pause, currentTimeRef]);

  // Apply trim via FFmpeg
  const handleApplyTrim = useCallback(() => {
    if (!selectedSegment || isTrimming) return;

    const isFullRange =
      Math.abs(trimStart) < 0.1 &&
      Math.abs(trimEnd - selectedSegment.duration) < 0.1;

    if (isFullRange) {
      Alert.alert('No Trim Needed', 'The trim covers the entire recording. Adjust the handles to trim.');
      return;
    }

    if (trimEnd <= trimStart) {
      Alert.alert('Invalid Range', 'The trim end must be after the start.');
      return;
    }

    const keepDuration = trimEnd - trimStart;
    if (keepDuration < 1) {
      Alert.alert('Too Short', 'The trimmed result must be at least 1 second long.');
      return;
    }

    pause();
    setIsTrimming(true);

    (async () => {
      try {
        await audioTempFiles.ensureDir();
        const outputPath = audioTempFiles.getTrimOutputPath(selectedIndex);

        const result = await trimAudio(
          selectedSegment.uri,
          trimStart,
          trimEnd,
          outputPath
        );

        // Validate output is usable
        if (result.duration < 0.1) {
          throw new Error('Trim produced invalid output (duration near zero)');
        }

        // Update segments with trimmed file
        const newSegments = [...segments];
        const oldUri = newSegments[selectedIndex].uri;
        newSegments[selectedIndex] = {
          uri: result.uri,
          duration: result.duration,
          peakMetering: undefined,
        };
        setSegments(newSegments);

        // Clear cached peaks for this segment (they're now stale)
        setPeaks((prev) => {
          const next = new Map(prev);
          next.delete(selectedIndex);
          return next;
        });

        // Reset trim handles to full range of new file
        setTrimStart(0);
        setTrimEnd(result.duration);
        setHasChanges(true);

        // Load new source BEFORE deleting old file — prevents playback stutter
        loadSource(result.uri).catch(() => {});

        // Now safe to delete the old file
        safeDeleteFile(oldUri);

        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        Alert.alert('Trim Applied', `Recording trimmed to ${formatTime(result.duration)}.`);
      } catch (error) {
        if (__DEV__) console.error('[Editor] trim failed:', error);
        Alert.alert('Trim Failed', 'Could not trim the recording. Please try again.');
      } finally {
        setIsTrimming(false);
      }
    })().catch(() => {
      setIsTrimming(false);
    });
  }, [selectedSegment, selectedIndex, segments, trimStart, trimEnd, isTrimming, pause, loadSource]);

  // Delete a segment
  const handleDeleteSegment = useCallback(
    (index: number) => {
      if (segments.length <= 1) {
        Alert.alert('Cannot Delete', 'You must keep at least one recording segment.');
        return;
      }

      const seg = segments[index];
      Alert.alert(
        'Delete Segment?',
        `Segment ${index + 1} (${formatTime(seg.duration)}) will be permanently deleted.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              pause();
              safeDeleteFile(seg.uri);
              // Use functional updater to avoid stale closure over `segments` —
              // a concurrent trim between alert-show and confirm would otherwise
              // filter the wrong array and potentially delete the wrong segment.
              setSegments((latestSegments) => {
                if (!latestSegments[index]) return latestSegments;
                return latestSegments.filter((_, i) => i !== index);
              });

              // Clear peaks for deleted and subsequent indices
              setPeaks(new Map());

              // Adjust selected index (selectedIndex/segments.length may be
              // slightly stale here, but that only affects which tab is focused —
              // not data integrity).
              const approxNewLength = segments.length - 1;
              if (selectedIndex >= approxNewLength) {
                setSelectedIndex(Math.max(0, approxNewLength - 1));
              } else if (selectedIndex === index) {
                setSelectedIndex(Math.max(0, index - 1));
              }

              setHasChanges(true);
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
            },
          },
        ]
      );
    },
    [segments, selectedIndex, pause]
  );

  // Reset trim handles to full range
  const handleReset = useCallback(() => {
    if (selectedSegment) {
      setTrimStart(0);
      setTrimEnd(selectedSegment.duration);
    }
  }, [selectedSegment]);

  // Done — emit result and pop back to Record screen
  const handleDone = useCallback(() => {
    pause();
    if (hasChanges) {
      savedResultRef.current = true; // Prevent temp file cleanup — session needs trimmed files
      if (__DEV__) console.log('[Editor] emitting result:', slotId, segments.length, 'segs, durations:', segments.map(s => s.duration));
      audioEditorBridge.emitResult({ slotId, segments });
    } else {
      audioEditorBridge.emitResult(null);
    }
    setHasChanges(false); // Prevent navigation guard from firing
    router.back();
  }, [hasChanges, slotId, segments, pause, router]);

  // Go back without saving
  const handleBack = useCallback(() => {
    if (hasChanges) {
      Alert.alert(
        'Discard Changes?',
        'Your edits will be lost.',
        [
          { text: 'Keep Editing', style: 'cancel' },
          {
            text: 'Discard',
            style: 'destructive',
            onPress: () => {
              pause();
              audioEditorBridge.emitResult(null);
              setHasChanges(false);
              router.back();
            },
          },
        ]
      );
    } else {
      pause();
      audioEditorBridge.emitResult(null);
      router.back();
    }
  }, [hasChanges, pause, router]);

  const currentPeaks = peaks.get(selectedIndex) ?? [];
  const isPeaksLoading = peaksLoading.has(selectedIndex);
  const hasPeakError = peakErrors.has(selectedIndex);

  const handleRetryPeaks = useCallback(() => {
    setPeakErrors((prev) => {
      const next = new Set(prev);
      next.delete(selectedIndex);
      return next;
    });
    setPeaks((prev) => {
      const next = new Map(prev);
      next.delete(selectedIndex);
      return next;
    });
  }, [selectedIndex]);

  if (isConcatenating) {
    return (
      <SafeAreaView className="flex-1 bg-stone-50 items-center justify-center">
        <ActivityIndicator size="large" color="#0d8775" />
        <Text className="text-body text-stone-500 mt-3">Merging segments...</Text>
      </SafeAreaView>
    );
  }

  if (!input || segments.length === 0) {
    return (
      <SafeAreaView className="flex-1 bg-stone-50 items-center justify-center">
        <Text className="text-body text-stone-500">No recording to edit.</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-stone-50">
      {/* Header */}
      <View className="flex-row items-center justify-between px-5 pt-3 pb-2">
        <Pressable
          onPress={handleBack}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={8}
          className="p-2 -ml-2"
        >
          <ArrowLeft color="#44403c" size={24} />
        </Pressable>
        <Text className="text-body-lg font-bold text-stone-900">Edit Recording</Text>
        <Button
          variant="primary"
          size="sm"
          onPress={handleDone}
          disabled={isTrimming}
        >
          Done
        </Button>
      </View>

      {/* Segment tabs — outside ScrollView so horizontal scroll doesn't conflict */}
      {segments.length > 1 && (
        <View className="mb-4 px-5" style={{ maxWidth: 600, alignSelf: 'center', width: '100%' }}>
          <Text className="text-body-sm font-semibold text-stone-600 mb-2">
            Segments ({segments.length})
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View className="flex-row gap-2">
              {segments.map((seg, i) => (
                <Pressable
                  key={i}
                  disabled={isTrimming}
                  onPress={() => {
                    pause();
                    setSelectedIndex(i);
                  }}
                  onLongPress={segments.length > 1 ? () => {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
                    handleDeleteSegment(i);
                  } : undefined}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: i === selectedIndex }}
                  accessibilityLabel={`Segment ${i + 1}, ${formatTime(seg.duration)}`}
                  accessibilityHint={segments.length > 1 ? 'Long press to delete this segment' : undefined}
                  className={`px-3 py-2 rounded-full ${
                    i === selectedIndex ? 'bg-brand-600' : 'bg-stone-200'
                  }`}
                >
                  <Text
                    className={`text-body-sm font-medium ${
                      i === selectedIndex ? 'text-white' : 'text-stone-600'
                    }`}
                  >
                    Seg {i + 1} ({formatTime(seg.duration)})
                  </Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        </View>
      )}

      {/* Waveform editor — OUTSIDE ScrollView so gestures have no competition */}
      <View className="mb-4 px-5" style={{ maxWidth: 600, alignSelf: 'center', width: '100%' }}>
        {hasPeakError && !isPeaksLoading ? (
          <View className="rounded-lg bg-stone-100 p-4 items-center" style={{ height: 120, justifyContent: 'center' }}>
            <Text className="text-body-sm text-stone-600 mb-2">
              Could not load waveform. You can still trim by time.
            </Text>
            <Button variant="secondary" size="sm" onPress={handleRetryPeaks}>
              Retry
            </Button>
          </View>
        ) : (
          <WaveformEditor
            peaks={currentPeaks}
            duration={selectedSegment?.duration ?? 0}
            currentTimeSV={currentTimeSV}
            trimStart={trimStart}
            trimEnd={trimEnd}
            onTrimChange={handleTrimChange}
            onSeek={handleSeek}
            isLoading={isPeaksLoading}
          />
        )}
      </View>

      {/* Everything below the waveform can scroll on small screens */}
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-5 pb-8"
        contentContainerStyle={{ maxWidth: 600, alignSelf: 'center', width: '100%' }}
        showsVerticalScrollIndicator={false}
      >
        {/* Playback controls */}
        <View className="flex-row items-center justify-center gap-6 mb-6">
          <Pressable
            onPress={handleSkipBack}
            accessibilityRole="button"
            accessibilityLabel="Skip back 10 seconds"
            hitSlop={8}
            className="p-3"
          >
            <SkipBack color="#44403c" size={24} />
          </Pressable>
          <Pressable
            onPress={() => toggle()}
            disabled={!isLoaded}
            accessibilityRole="button"
            accessibilityLabel={isPlaying ? 'Pause' : 'Play'}
            accessibilityHint="Double-tap to start or stop audio playback"
            className={`w-14 h-14 rounded-full items-center justify-center shadow-btn ${isLoaded ? 'bg-brand-500' : 'bg-stone-300'}`}
          >
            {isPlaying
              ? <Pause color="#fff" size={24} fill="#fff" />
              : <Play color="#fff" size={24} fill="#fff" />
            }
          </Pressable>
          <Pressable
            onPress={handleSkipForward}
            accessibilityRole="button"
            accessibilityLabel="Skip forward 10 seconds"
            hitSlop={8}
            className="p-3"
          >
            <SkipForward color="#44403c" size={24} />
          </Pressable>
        </View>

        {/* Current time display — isolated component, re-renders only once per second */}
        <PlaybackTimeDisplay
          currentTimeSV={currentTimeSV}
          duration={selectedSegment?.duration ?? 0}
        />
        {isPreviewMode && (
          <Text className="text-center text-caption text-brand-600 font-medium mb-4">
            Previewing trim region
          </Text>
        )}
        {!isPreviewMode && <View className="mb-5" />}

        {/* Trim action buttons */}
        <View className="gap-3">
          {(() => {
            const isAtFullRange =
              Math.abs(trimStart) < 0.1 &&
              Math.abs(trimEnd - (selectedSegment?.duration ?? 0)) < 0.1;
            return (
              <>
                <Button
                  variant="secondary"
                  onPress={handlePreview}
                  disabled={isTrimming || isAtFullRange}
                >
                  Preview Trim
                </Button>
                <Button
                  variant="primary"
                  onPress={handleApplyTrim}
                  loading={isTrimming}
                  disabled={isTrimming || isAtFullRange}
                >
                  Apply Trim
                </Button>
                <Button
                  variant="ghost"
                  onPress={handleReset}
                  disabled={isTrimming || isAtFullRange}
                >
                  Reset to Full Range
                </Button>
              </>
            );
          })()}
        </View>

        {/* Trimming overlay */}
        {isTrimming && (
          <View className="items-center mt-4">
            <ActivityIndicator size="small" color="#0d8775" />
            <Text className="text-body-sm text-stone-500 mt-2">Trimming audio...</Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
