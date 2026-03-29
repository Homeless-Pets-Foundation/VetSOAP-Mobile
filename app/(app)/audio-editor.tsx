import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, Alert, ScrollView, Pressable, ActivityIndicator } from 'react-native';
import { useNavigation } from 'expo-router';
import { usePreventRemove } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, Play, Pause, SkipBack, SkipForward } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import * as FileSystem from 'expo-file-system';
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
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export default function AudioEditorScreen() {
  const navigation = useNavigation();

  // Load input from bridge on mount
  const inputRef = useRef(audioEditorBridge.getInput());
  const slotId = inputRef.current?.slotId ?? '';

  const [segments, setSegments] = useState<AudioSegment[]>(
    () => inputRef.current?.segments ?? []
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
  const initialSegmentCountRef = useRef(inputRef.current?.segments.length ?? 0);

  const playback = useAudioPlayback();

  // Auto-concatenate multiple segments into one on mount
  useEffect(() => {
    if (initialSegmentCountRef.current <= 1) return;

    setIsConcatenating(true);
    (async () => {
      try {
        await audioTempFiles.ensureDir();
        const outputPath = audioTempFiles.getConcatOutputPath();
        const uris = (inputRef.current?.segments ?? []).map((s) => s.uri);
        const result = await concatenateAudio(uris, outputPath);
        setSegments([{ uri: result.uri, duration: result.duration }]);
        setSelectedIndex(0);
        setHasChanges(true);
        Alert.alert('Segments Merged', `${initialSegmentCountRef.current} recording segments have been combined into one.`);
      } catch (error) {
        if (__DEV__) console.error('[Editor] concatenation failed:', error);
        Alert.alert('Note', 'Could not merge segments. You can edit each segment individually.');
      } finally {
        setIsConcatenating(false);
      }
    })().catch(() => {
      setIsConcatenating(false);
    });
  }, []);

  // Selected segment
  const selectedSegment = segments[selectedIndex] ?? null;

  // Load audio source when segment changes
  const selectedUri = selectedSegment?.uri;
  const selectedDuration = selectedSegment?.duration ?? 0;
  useEffect(() => {
    if (selectedUri) {
      playback.loadSource(selectedUri);
      setTrimStart(0);
      setTrimEnd(selectedDuration);
    }
  }, [selectedUri, selectedDuration, playback]);

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
        const peakData = await extractWaveformPeaks(selectedUri, 300);
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
        audioTempFiles.cleanupAll().catch(() => {});
      }
    };
  }, []);

  const handleTrimChange = useCallback((start: number, end: number) => {
    setTrimStart(start);
    setTrimEnd(end);
  }, []);

  const handleSeek = useCallback(
    (seconds: number) => {
      playback.seekTo(seconds).catch(() => {});
    },
    [playback]
  );

  const handleSkipBack = useCallback(() => {
    playback.seekTo(Math.max(0, playback.currentTime - 10)).catch(() => {});
  }, [playback]);

  const handleSkipForward = useCallback(() => {
    const maxTime = selectedSegment?.duration ?? 0;
    playback.seekTo(Math.min(maxTime, playback.currentTime + 10)).catch(() => {});
  }, [playback, selectedSegment?.duration]);

  // Preview: play only the trimmed region
  const [isPreviewMode, setIsPreviewMode] = useState(false);

  const handlePreview = useCallback(() => {
    setIsPreviewMode(true);
    playback.seekTo(trimStart).then(() => {
      playback.play();
    }).catch(() => {});
  }, [playback, trimStart]);

  // Stop playback at trim end during preview (with 0.15s tolerance for timing jitter)
  const { isPlaying, currentTime: playbackTime, pause: pausePlayback } = playback;
  useEffect(() => {
    if (isPreviewMode && isPlaying && playbackTime >= trimEnd - 0.15 && trimEnd < selectedDuration) {
      pausePlayback();
      setIsPreviewMode(false);
    }
    // Clear preview mode if user pauses manually
    if (isPreviewMode && !isPlaying) {
      setIsPreviewMode(false);
    }
  }, [playbackTime, isPlaying, trimEnd, selectedDuration, pausePlayback, isPreviewMode]);

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

    playback.pause();
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
        newSegments[selectedIndex] = { uri: result.uri, duration: result.duration };
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
        playback.loadSource(result.uri);

        // Now safe to delete the old file
        FileSystem.deleteAsync(oldUri, { idempotent: true }).catch(() => {});

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
  }, [selectedSegment, selectedIndex, segments, trimStart, trimEnd, isTrimming, playback]);

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
              playback.pause();
              FileSystem.deleteAsync(seg.uri, { idempotent: true }).catch(() => {});
              const newSegments = segments.filter((_, i) => i !== index);
              setSegments(newSegments);

              // Clear peaks for deleted and subsequent indices
              setPeaks(new Map());

              // Adjust selected index
              if (selectedIndex >= newSegments.length) {
                setSelectedIndex(Math.max(0, newSegments.length - 1));
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
    [segments, selectedIndex, playback]
  );

  // Reset trim handles to full range
  const handleReset = useCallback(() => {
    if (selectedSegment) {
      setTrimStart(0);
      setTrimEnd(selectedSegment.duration);
    }
  }, [selectedSegment]);

  // Done — emit result and go back
  const handleDone = useCallback(() => {
    playback.pause();
    if (hasChanges) {
      savedResultRef.current = true; // Prevent temp file cleanup — session needs trimmed files
      audioEditorBridge.emitResult({ slotId, segments });
    } else {
      audioEditorBridge.emitResult(null);
    }
    setHasChanges(false); // Prevent navigation guard from firing
    navigation.goBack();
  }, [hasChanges, slotId, segments, playback, navigation]);

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
              playback.pause();
              audioEditorBridge.emitResult(null);
              setHasChanges(false);
              navigation.goBack();
            },
          },
        ]
      );
    } else {
      playback.pause();
      audioEditorBridge.emitResult(null);
      navigation.goBack();
    }
  }, [hasChanges, playback, navigation]);

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

  if (!inputRef.current || segments.length === 0) {
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

      <ScrollView
        className="flex-1"
        contentContainerClassName="px-5 pb-8"
        contentContainerStyle={{ maxWidth: 600, alignSelf: 'center', width: '100%' }}
        showsVerticalScrollIndicator={false}
      >
        {/* Segment tabs */}
        {segments.length > 1 && (
          <View className="mb-4">
            <Text className="text-body-sm font-semibold text-stone-600 mb-2">
              Segments ({segments.length})
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View className="flex-row gap-2">
                {segments.map((seg, i) => (
                  <Pressable
                    key={i}
                    onPress={() => {
                      playback.pause();
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

        {/* Waveform editor */}
        <View className="mb-6">
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
              currentTime={playback.currentTime}
              trimStart={trimStart}
              trimEnd={trimEnd}
              onTrimChange={handleTrimChange}
              onSeek={handleSeek}
              isLoading={isPeaksLoading}
            />
          )}
        </View>

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
            onPress={() => playback.toggle()}
            accessibilityRole="button"
            accessibilityLabel={playback.isPlaying ? 'Pause' : 'Play'}
            accessibilityHint="Double-tap to start or stop audio playback"
            className="w-14 h-14 rounded-full bg-brand-500 items-center justify-center shadow-btn"
          >
            {playback.isPlaying ? (
              <Pause color="#fff" size={24} fill="#fff" />
            ) : (
              <Play color="#fff" size={24} fill="#fff" />
            )}
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

        {/* Current time display */}
        <Text className="text-center text-body text-stone-500 mb-1">
          {formatTime(playback.currentTime)} / {formatTime(selectedSegment?.duration ?? 0)}
        </Text>
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
