import React, { useState, useEffect, useCallback, useRef } from 'react';
import { View, Text, Alert, ScrollView, Pressable, ActivityIndicator, InteractionManager, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useNavigation, useRouter } from 'expo-router';
import { usePreventRemove, useFocusEffect } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, Play, Pause, SkipBack, SkipForward, Undo2, Redo2, X, ArrowLeftRight, StopCircle, ListMusic } from 'lucide-react-native';
import * as Haptics from 'expo-haptics';
import Animated, { useAnimatedReaction, runOnJS, useSharedValue, useAnimatedStyle, withTiming, withSpring, LinearTransition } from 'react-native-reanimated';
import type { SharedValue } from 'react-native-reanimated';
import { safeDeleteFile } from '../../src/lib/fileOps';
import { useAudioPlayback } from '../../src/hooks/useAudioPlayback';
import { audioEditorBridge } from '../../src/lib/audioEditorBridge';
import { trimAudio, concatenateAudio, extractWaveformPeaks } from '../../src/lib/ffmpeg';
import { detectSilenceBounds } from '../../src/lib/silenceDetect';
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

/**
 * Single segment tab. Lives in its own component so each tab can hold its own gesture
 * + animated style hooks. Long-press + drag (300ms hold) triggers reorder; tapping
 * selects; tapping the × deletes (with confirmation).
 */
function SegmentTab({
  index,
  label,
  segment,
  isSelected,
  isOnly,
  disabled,
  onSelect,
  onDelete,
  onLayoutTab,
  draggingIndexSV,
  dragTranslationXSV,
  targetIndexSV,
  draggedTabWidthSV,
  onLiveDragChange,
  onDropEnd,
}: {
  index: number;
  label: number;
  segment: AudioSegment;
  isSelected: boolean;
  isOnly: boolean;
  disabled: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onLayoutTab: (index: number, x: number, width: number) => void;
  draggingIndexSV: SharedValue<number>;
  dragTranslationXSV: SharedValue<number>;
  targetIndexSV: SharedValue<number>;
  draggedTabWidthSV: SharedValue<number>;
  onLiveDragChange: (fromIndex: number, deltaX: number) => void;
  onDropEnd: (index: number, finalDeltaX: number) => void;
}) {
  // Per-tab measured width — captured in onLayout, used to seed draggedTabWidthSV when
  // this tab becomes the dragged one so other tabs know how far to shift.
  const tabWidthRef = useRef(0);

  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const { x, width } = e.nativeEvent.layout;
      tabWidthRef.current = width;
      onLayoutTab(index, x, width);
    },
    [index, onLayoutTab]
  );

  // Pan that only activates after a 300ms long-press — single taps still pass through
  // to the wrapped Pressable's onPress (select).
  const dragGesture = React.useMemo(
    () =>
      Gesture.Pan()
        .activateAfterLongPress(300)
        .onStart(() => {
          'worklet';
          draggingIndexSV.value = index;
          dragTranslationXSV.value = 0;
          targetIndexSV.value = index;
          draggedTabWidthSV.value = tabWidthRef.current;
        })
        .onChange((event) => {
          'worklet';
          if (draggingIndexSV.value !== index) return;
          dragTranslationXSV.value = event.translationX;
          // Recompute target on JS thread so it can read tabLayoutsRef. Worklet-side
          // bookkeeping (targetIndexSV) is updated inside the JS callback.
          runOnJS(onLiveDragChange)(index, event.translationX);
        })
        .onEnd((event) => {
          'worklet';
          if (draggingIndexSV.value !== index) return;
          const finalDelta = event.translationX;
          // Snap visual back; the new order will re-render the tab in its new position.
          dragTranslationXSV.value = withTiming(0, { duration: 180 });
          draggingIndexSV.value = -1;
          targetIndexSV.value = -1;
          draggedTabWidthSV.value = 0;
          runOnJS(onDropEnd)(index, finalDelta);
        })
        .onFinalize(() => {
          'worklet';
          // Belt-and-suspenders: cancel/timeout/etc. clean up state
          if (draggingIndexSV.value === index) {
            draggingIndexSV.value = -1;
            dragTranslationXSV.value = 0;
            targetIndexSV.value = -1;
            draggedTabWidthSV.value = 0;
          }
        }),
    [index, draggingIndexSV, dragTranslationXSV, targetIndexSV, draggedTabWidthSV, onLiveDragChange, onDropEnd]
  );

  // Animated style:
  //  - Dragged tab: lifted, scaled, and translated by the finger delta.
  //  - Other tabs: spring-shift left/right by the dragged tab's width to make room.
  //    All transitions use withSpring/withTiming so changes feel smooth, not snappy.
  const SPRING = { damping: 18, stiffness: 220, mass: 0.8 };
  const animatedStyle = useAnimatedStyle(() => {
    const isDragging = draggingIndexSV.value === index;
    if (isDragging) {
      return {
        transform: [
          { translateX: dragTranslationXSV.value },
          { translateY: withTiming(-10, { duration: 150 }) },
          { scale: withTiming(1.05, { duration: 150 }) },
        ],
        zIndex: 100,
        shadowColor: '#000',
        shadowOpacity: withTiming(0.3, { duration: 150 }),
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 4 },
        elevation: 8,
      };
    }

    // Compute preview shift: when another tab is being dragged toward this position,
    // slide aside to open up room. The dragged tab's width is the gap to make.
    const draggedIdx = draggingIndexSV.value;
    const targetIdx = targetIndexSV.value;
    const w = draggedTabWidthSV.value + 8; // include the 8px row gap
    let previewShift = 0;
    if (draggedIdx !== -1 && targetIdx !== -1) {
      if (draggedIdx < index && index <= targetIdx) {
        // Dragging from left toward us — shift left to fill the vacated slot.
        previewShift = -w;
      } else if (targetIdx <= index && index < draggedIdx) {
        // Dragging from right toward us — shift right to make room.
        previewShift = w;
      }
    }

    return {
      transform: [
        { translateX: withSpring(previewShift, SPRING) },
        { translateY: withTiming(0, { duration: 150 }) },
        { scale: withTiming(1, { duration: 150 }) },
      ],
      zIndex: 0,
      shadowColor: '#000',
      shadowOpacity: withTiming(0, { duration: 150 }),
      shadowRadius: 0,
      shadowOffset: { width: 0, height: 0 },
      elevation: 0,
    };
  });

  return (
    <GestureDetector gesture={dragGesture}>
      <Animated.View
        style={animatedStyle}
        onLayout={handleLayout}
        layout={LinearTransition.duration(220)}
      >
        <Pressable
          disabled={disabled}
          onPress={onSelect}
          accessibilityRole="tab"
          accessibilityState={{ selected: isSelected }}
          accessibilityLabel={`Segment ${label}, ${formatTime(segment.duration)}`}
          accessibilityHint={!isOnly ? 'Long press and drag to reorder. Tap × to delete.' : undefined}
          className={`pl-3 ${!isOnly ? 'pr-1' : 'pr-3'} py-2 rounded-full flex-row items-center gap-2 ${
            isSelected ? 'bg-brand-600' : 'bg-stone-200'
          }`}
        >
          <Text
            className={`text-body-sm font-medium ${
              isSelected ? 'text-white' : 'text-stone-600'
            }`}
          >
            Seg {label} ({formatTime(segment.duration)})
          </Text>
          {!isOnly && (
            <Pressable
              onPress={onDelete}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel={`Delete segment ${label}`}
              hitSlop={6}
              className={`w-6 h-6 rounded-full items-center justify-center ${
                isSelected ? 'bg-white/20' : 'bg-stone-300'
              }`}
            >
              <X
                size={14}
                color={isSelected ? '#ffffff' : '#57534e'}
                strokeWidth={2.5}
              />
            </Pressable>
          )}
        </Pressable>
      </Animated.View>
    </GestureDetector>
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
  // Stable per-segment display labels, parallel to segments[]. Reorder moves labels with
  // their segments (so users can track which piece they moved); add/remove ops rebuild
  // the sequence so the visible labels stay clean.
  //   - delete + merge → renumber 1..N
  //   - split → original keeps its label; new piece gets max(labels)+1
  //   - reorder → labels move with their segments
  const [segmentLabels, setSegmentLabels] = useState<number[]>(
    () => (input?.segments ?? []).map((_, i) => i + 1)
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
  // URIs provided by the caller when this editing session opened. Only the caller
  // (record.tsx setResultCallback) may delete these — the editor must not touch them.
  const inputUrisRef = useRef<Set<string>>(new Set());
  const [isConcatenating, setIsConcatenating] = useState(false);
  // Bumped each time the screen opens with new input — triggers concatenation effect
  const [sessionKey, setSessionKey] = useState(0);
  const initialSegmentCountRef = useRef(input?.segments.length ?? 0);

  // Container width of the waveform region — drives adaptive peak density (below).
  // Measured on layout; initial 0 means the first peak extraction uses a sensible default.
  const [waveformContainerWidth, setWaveformContainerWidth] = useState(0);

  const playback = useAudioPlayback();
  const { seekTo, pause, play, toggle, loadSource, isLoaded, isPlaying, duration: playerDuration, currentTimeSV, currentTimeRef } = playback;

  // Play All mode — when active, the player is loaded with a temp concat of every
  // segment in order so the user can preview the final stitched output. Auto-stops at
  // natural EOF and restores the selected-segment source.
  const [isPlayingAll, setIsPlayingAll] = useState(false);
  const playAllUriRef = useRef<string | null>(null);

  // Drag-to-reorder shared values, owned at the parent so per-tab gestures and animated
  // styles can read/write them on the UI thread without React re-renders.
  // Also drives the ScrollView's scrollEnabled flag (via a tiny React state mirror).
  const draggingIndexSV = useSharedValue(-1);
  const dragTranslationXSV = useSharedValue(0);
  // Live "would-land-here" target index during drag. Other tabs read this in their
  // animated style and spring-shift to make room as the dragged tab passes over them.
  const targetIndexSV = useSharedValue(-1);
  // Width of the dragged tab — drives how far other tabs shift to make room.
  const draggedTabWidthSV = useSharedValue(0);
  const tabLayoutsRef = useRef<Array<{ x: number; width: number }>>([]);
  const [isDraggingTab, setIsDraggingTab] = useState(false);
  useAnimatedReaction(
    () => draggingIndexSV.value !== -1,
    (active, prev) => {
      'worklet';
      if (active !== prev) runOnJS(setIsDraggingTab)(active);
    }
  );

  // Live target-index calculation during drag. Called from the worklet via runOnJS so
  // we can read tabLayoutsRef on the JS thread. Only writes the shared value when the
  // computed target changes, to keep useAnimatedStyle re-evaluations cheap.
  const updateDragTarget = useCallback((fromIndex: number, deltaX: number) => {
    const layouts = tabLayoutsRef.current;
    const fromLayout = layouts[fromIndex];
    if (!fromLayout) return;
    const fingerCenter = fromLayout.x + fromLayout.width / 2 + deltaX;
    let bestIndex = fromIndex;
    let bestDist = Infinity;
    for (let i = 0; i < layouts.length; i++) {
      const lay = layouts[i];
      if (!lay) continue;
      const center = lay.x + lay.width / 2;
      const dist = Math.abs(center - fingerCenter);
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = i;
      }
    }
    if (targetIndexSV.value !== bestIndex) {
      targetIndexSV.value = bestIndex;
    }
  }, [targetIndexSV]);

  // Shared values mirror React trim state so worklets (preview stop, scrub, nudge) can read/write
  // on the UI thread without bouncing through setState. Owned here so Step 3a nudge buttons can
  // mutate them directly; Step 2b scrub needs to read them to avoid hijacking handle pans.
  const trimStartSV = useSharedValue(0);
  const trimEndSV = useSharedValue(0);
  const isPreviewModeSV = useSharedValue(false);
  useEffect(() => {
    trimStartSV.value = trimStart;
    trimEndSV.value = trimEnd;
  }, [trimStart, trimEnd, trimStartSV, trimEndSV]);

  // Re-read bridge input when screen regains focus (Tab screens stay mounted between visits)
  useFocusEffect(
    useCallback(() => {
      const bridgeInput = audioEditorBridge.getInput();
      if (!bridgeInput) return; // No new input — screen was focused without a new edit request
      if (__DEV__) console.log('[Editor] focus: new input for slot', bridgeInput.slotId, bridgeInput.segments.length, 'segs');
      setInput(bridgeInput);
      setSegments(bridgeInput.segments);
      setSegmentLabels(bridgeInput.segments.map((_, i) => i + 1));
      inputUrisRef.current = new Set(bridgeInput.segments.map((s) => s.uri));
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
      // Clear undo history on new session — otherwise a later edit could "undo" back into
      // a previous patient's segments, which would be both confusing and a PHI risk.
      historyRef.current = { past: [], future: [] };
      setHistoryVersion((v) => v + 1);
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
        setSegmentLabels([1]);
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

  // Sum of all segment durations — what the user will actually upload on Done
  const totalDuration = React.useMemo(
    () => segments.reduce((sum, seg) => sum + seg.duration, 0),
    [segments]
  );

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

  // Adaptive density: roughly one peak per 3 dp of container width, clamped to [150, 400].
  // Waveform cache keys on (uri, size) so bumping density auto-invalidates stale caches.
  // FFmpeg's seek-based sampling cost is in positions, not peaks-per-position — higher
  // density is effectively free past the SHORT_FILE_THRESHOLD.
  const computeTargetPeaks = useCallback(() => {
    return waveformContainerWidth > 0
      ? Math.min(400, Math.max(150, Math.floor(waveformContainerWidth / 3)))
      : 150;
  }, [waveformContainerWidth]);

  const extractPeaksForIndex = useCallback(async (index: number, uri: string) => {
    // Dedupe against in-flight extractions and already-loaded peaks
    if (peaksRef.current.has(index)) return;
    if (peaksLoadingRef.current.has(index)) return;
    setPeaksLoading((prev) => new Set(prev).add(index));
    try {
      const peakData = await extractWaveformPeaks(uri, computeTargetPeaks());
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
  }, [computeTargetPeaks]);

  useEffect(() => {
    if (!selectedUri) return;
    if (peaksRef.current.has(selectedIndex)) return;
    if (peaksLoadingRef.current.has(selectedIndex)) return;

    const index = selectedIndex;
    const uri = selectedUri;
    const currentSegments = segments;

    (async () => {
      await extractPeaksForIndex(index, uri);
      // Prefetch adjacent segments once the active one has peaks. Runs after React has
      // flushed and any in-flight interactions have settled, so it never competes with
      // user-visible work. Switching segments then feels instant — no loading spinner.
      InteractionManager.runAfterInteractions(() => {
        const prev = currentSegments[index - 1];
        const next = currentSegments[index + 1];
        if (prev?.uri) extractPeaksForIndex(index - 1, prev.uri).catch(() => {});
        if (next?.uri) extractPeaksForIndex(index + 1, next.uri).catch(() => {});
      });
    })().catch(() => {});
  // waveformContainerWidth / segments / extractPeaksForIndex intentionally excluded —
  // the extraction should not re-run on mid-lifetime layout changes or segment-array
  // identity churn. Closure captures the current values at the time of trigger.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Undo/redo history. Snapshot is taken BEFORE each destructive op (apply trim, delete
  // segment, split, auto-trim-silence). Past is capped at HISTORY_MAX to bound memory;
  // since audio file URIs are referenced (not copied) this is cheap. Future is cleared on
  // any new destructive op so a Trim → Undo → NewTrim loses the redone state (standard
  // stack behaviour).
  const HISTORY_MAX = 20;
  type EditorSnapshot = {
    segments: AudioSegment[];
    segmentLabels: number[];
    selectedIndex: number;
    trimStart: number;
    trimEnd: number;
  };
  const historyRef = useRef<{ past: EditorSnapshot[]; future: EditorSnapshot[] }>({
    past: [],
    future: [],
  });
  const [historyVersion, setHistoryVersion] = useState(0); // bumped to re-render button disabled state

  // Refs shadow the state so captureSnapshot is stable and always reads current values —
  // avoids stale-closure bugs in event handlers that call pushHistory().
  const segmentsStateRef = useRef(segments);
  segmentsStateRef.current = segments;
  const segmentLabelsRef = useRef(segmentLabels);
  segmentLabelsRef.current = segmentLabels;
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;
  const trimStartStateRef = useRef(trimStart);
  trimStartStateRef.current = trimStart;
  const trimEndStateRef = useRef(trimEnd);
  trimEndStateRef.current = trimEnd;

  const captureSnapshot = useCallback((): EditorSnapshot => ({
    segments: segmentsStateRef.current.map((s) => ({ ...s })),
    segmentLabels: [...segmentLabelsRef.current],
    selectedIndex: selectedIndexRef.current,
    trimStart: trimStartStateRef.current,
    trimEnd: trimEndStateRef.current,
  }), []);

  const pushHistory = useCallback(() => {
    const snap = captureSnapshot();
    const { past } = historyRef.current;
    past.push(snap);
    if (past.length > HISTORY_MAX) past.shift();
    historyRef.current.future = []; // new action invalidates redo stack
    setHistoryVersion((v) => v + 1);
  }, [captureSnapshot]);

  const applySnapshot = useCallback((snap: EditorSnapshot) => {
    // Compute per-index URI deltas BEFORE setSegments so we read the current segments
    // synchronously from the ref (state hasn't been replaced yet).
    const currentSegs = segmentsStateRef.current;
    const changedIndices = new Set<number>();
    snap.segments.forEach((seg, i) => {
      if (currentSegs[i]?.uri !== seg.uri) changedIndices.add(i);
    });
    // Indices that no longer exist in the restored snapshot must drop their peak entries.
    for (let i = snap.segments.length; i < currentSegs.length; i++) changedIndices.add(i);

    setSegments(snap.segments);
    setSegmentLabels(snap.segmentLabels);
    setSelectedIndex(snap.selectedIndex);
    setTrimStart(snap.trimStart);
    setTrimEnd(snap.trimEnd);
    // Only invalidate peaks for indices whose underlying audio URI actually changed.
    // Undoing a trim-handle-only mutation (Trim Silence (auto), nudges committed via Apply
    // Trim that we're undoing back to a no-trim state, etc.) must NOT blank the waveform —
    // the peaks for the unchanged URIs are still valid.
    if (changedIndices.size > 0) {
      setPeaks((prev) => {
        const next = new Map(prev);
        changedIndices.forEach((i) => next.delete(i));
        return next;
      });
      setPeakErrors((prev) => {
        const next = new Set(prev);
        changedIndices.forEach((i) => next.delete(i));
        return next;
      });
    }
    const uri = snap.segments[snap.selectedIndex]?.uri;
    if (uri) loadSource(uri).catch(() => {});
    setHasChanges(true);
    Haptics.selectionAsync().catch(() => {});
  }, [loadSource]);

  const handleUndo = useCallback(() => {
    const { past, future } = historyRef.current;
    if (past.length === 0) return;
    future.push(captureSnapshot());
    const snap = past.pop() as EditorSnapshot;
    applySnapshot(snap);
    setHistoryVersion((v) => v + 1);
  }, [captureSnapshot, applySnapshot]);

  const handleRedo = useCallback(() => {
    const { past, future } = historyRef.current;
    if (future.length === 0) return;
    past.push(captureSnapshot());
    if (past.length > HISTORY_MAX) past.shift();
    const snap = future.pop() as EditorSnapshot;
    applySnapshot(snap);
    setHistoryVersion((v) => v + 1);
  }, [captureSnapshot, applySnapshot]);

  const canUndo = historyRef.current.past.length > 0;
  const canRedo = historyRef.current.future.length > 0;
  void historyVersion; // force re-render on history change (captured by canUndo/canRedo above)

  // Nudge target — "last-touched handle". Defaults to 'end' because most workflows end by
  // trimming tail silence. Updated by TrimOverlay via onHandleActivate whenever a handle
  // is panned or tap-snapped.
  const lastActiveHandleRef = useRef<'start' | 'end'>('end');
  const [nudgeTarget, setNudgeTarget] = useState<'start' | 'end'>('end');
  const handleHandleActivate = useCallback((which: 'start' | 'end') => {
    lastActiveHandleRef.current = which;
    setNudgeTarget(which);
  }, []);

  // Nudge step sizes scale with the *current segment's* duration so a 10-second clinical
  // clip and a 5-minute appointment both get appropriate granularity. Bands are stable
  // ranges (no jitter at thresholds), and labels render the chosen step so the user
  // always sees what each tap will do. Recomputed when selectedSegment.duration changes —
  // handles split segments differently from the parent.
  const nudgeSteps = React.useMemo(() => {
    const dur = selectedSegment?.duration ?? 0;
    if (dur <= 30) return { coarse: 1, fine: 0.1 };
    if (dur <= 120) return { coarse: 5, fine: 0.5 };
    if (dur <= 600) return { coarse: 10, fine: 1 };
    return { coarse: 30, fine: 2 };
  }, [selectedSegment?.duration]);

  const nudgeHandle = useCallback(
    (deltaSec: number) => {
      const which = lastActiveHandleRef.current;
      const dur = selectedSegment?.duration ?? 0;
      if (dur <= 0) return;
      Haptics.selectionAsync().catch(() => {});
      if (which === 'start') {
        const next = Math.max(0, Math.min(trimStart + deltaSec, trimEnd - 1));
        setTrimStart(next);
      } else {
        const next = Math.max(trimStart + 1, Math.min(trimEnd + deltaSec, dur));
        setTrimEnd(next);
      }
    },
    [selectedSegment?.duration, trimStart, trimEnd]
  );

  // Long-press auto-repeat. setInterval cleared on release.
  const nudgeRepeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startNudgeRepeat = useCallback(
    (deltaSec: number) => {
      nudgeHandle(deltaSec);
      if (nudgeRepeatRef.current) clearInterval(nudgeRepeatRef.current);
      nudgeRepeatRef.current = setInterval(() => nudgeHandle(deltaSec), 100);
    },
    [nudgeHandle]
  );
  const stopNudgeRepeat = useCallback(() => {
    if (nudgeRepeatRef.current) {
      clearInterval(nudgeRepeatRef.current);
      nudgeRepeatRef.current = null;
    }
  }, []);
  useEffect(() => () => stopNudgeRepeat(), [stopNudgeRepeat]);

  // Scrub — pause audio while the user drags the playhead, then seek on release.
  // One seekTo call per gesture (vs. expo-audio's ~50ms seek latency × 10Hz during drag
  // producing audible glitches on weak hardware). We track wasPlaying so we can resume
  // after the seek completes.
  const scrubWasPlayingRef = useRef(false);
  const handleScrubStart = useCallback(() => {
    scrubWasPlayingRef.current = isPlaying;
    if (isPlaying) pause();
  }, [isPlaying, pause]);
  const handleScrubEnd = useCallback(
    (seconds: number) => {
      seekTo(seconds)
        .then(() => {
          if (scrubWasPlayingRef.current) play();
        })
        .catch(() => {})
        .finally(() => {
          scrubWasPlayingRef.current = false;
        });
    },
    [seekTo, play]
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

  const handlePreviewStart = useCallback(() => {
    setIsPreviewMode(true);
    isPreviewModeSV.value = true;
    seekTo(trimStart).then(() => {
      play();
    }).catch(() => {});
  }, [seekTo, play, trimStart, isPreviewModeSV]);

  const handlePreviewStop = useCallback(() => {
    pause();
    setIsPreviewMode(false);
    isPreviewModeSV.value = false;
  }, [pause, isPreviewModeSV]);

  const togglePreview = useCallback(() => {
    if (isPreviewMode) {
      handlePreviewStop();
    } else {
      handlePreviewStart();
    }
  }, [isPreviewMode, handlePreviewStart, handlePreviewStop]);

  // Stable ref so the UI-thread reaction below doesn't capture a stale loop callback
  const trimStartRef = useRef(trimStart);
  trimStartRef.current = trimStart;
  const seekAndPlayRef = useRef((start: number) => {
    seekTo(start).then(() => play()).catch(() => {});
  });
  seekAndPlayRef.current = (start: number) => {
    seekTo(start).then(() => play()).catch(() => {});
  };
  const invokePreviewLoop = useCallback(() => {
    // Re-enter the trimmed region — keep playing, do not pause
    seekAndPlayRef.current(trimStartRef.current);
  }, []);

  // Clear preview flag if user paused manually — reaction below handles the trim-end loop
  useEffect(() => {
    if (isPreviewMode && !isPlaying) {
      setIsPreviewMode(false);
      isPreviewModeSV.value = false;
    }
  }, [isPreviewMode, isPlaying, isPreviewModeSV]);

  // Loop playback at the trim-end handle. Runs on the UI thread — zero JS polling, seeks
  // back to trimStart within one frame of the crossing. Gives a continuous region preview
  // that mirrors Ableton / Ferrite's loop-region play.
  useAnimatedReaction(
    () => {
      'worklet';
      return isPreviewModeSV.value && currentTimeSV.value >= trimEndSV.value;
    },
    (shouldLoop, prev) => {
      'worklet';
      if (shouldLoop && !prev) {
        runOnJS(invokePreviewLoop)();
      }
    }
  );

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
    pushHistory();

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
          // Inherit source metering — trimming can't raise peak amplitude, so using the
          // source value is conservative. Prevents edited segments from bypassing the
          // silent-upload guard in record.tsx (which fails open when metering is missing).
          peakMetering: selectedSegment.peakMetering,
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

        // Old intermediate URIs are intentionally NOT eagerly deleted here — undo (step 4b)
        // needs them available to restore. cleanupAll() on unmount removes orphans on the
        // discard path; the Done path carries current segment URIs out via emitResult, so
        // the caller (record.tsx) takes ownership. Caller-provided input URIs are never
        // touched by the editor either way — noted here for future reference.
        void oldUri;

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
  }, [selectedSegment, selectedIndex, segments, trimStart, trimEnd, isTrimming, pause, loadSource, pushHistory]);

  // Delete a segment
  const handleDeleteSegment = useCallback(
    (index: number) => {
      if (segments.length <= 1) {
        Alert.alert('Cannot Delete', 'You must keep at least one recording segment.');
        return;
      }

      const seg = segments[index];
      const segLabel = segmentLabels[index] ?? index + 1;
      Alert.alert(
        'Delete Segment?',
        `Segment ${segLabel} (${formatTime(seg.duration)}) will be permanently deleted.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              pause();
              pushHistory();
              // Do NOT delete the file here. Caller-owned input URIs must only be
              // removed by record.tsx's setResultCallback after the user taps Done;
              // editor-produced temp files are cleaned up on unmount via audioTempFiles.
              // Deleting eagerly broke the Back → Discard path (file gone but session
              // still referenced it).
              // Use functional updater to avoid stale closure over `segments` —
              // a concurrent trim between alert-show and confirm would otherwise
              // filter the wrong array and potentially delete the wrong segment.
              setSegments((latestSegments) => {
                if (!latestSegments[index]) return latestSegments;
                return latestSegments.filter((_, i) => i !== index);
              });
              // Renumber labels sequentially after delete (per UX rule: deleting cleans up)
              setSegmentLabels((latestLabels) => {
                if (latestLabels.length <= index) return latestLabels;
                const after = latestLabels.filter((_, i) => i !== index);
                return after.map((_, i) => i + 1);
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
    [segments, selectedIndex, pause, pushHistory]
  );

  // Reset trim handles to full range
  const handleReset = useCallback(() => {
    if (selectedSegment) {
      setTrimStart(0);
      setTrimEnd(selectedSegment.duration);
    }
  }, [selectedSegment]);

  // Stable reference so useCallback deps downstream don't churn every render
  const currentPeaks = React.useMemo(
    () => peaks.get(selectedIndex) ?? [],
    [peaks, selectedIndex]
  );

  // Reorder a segment from one index to another. Triggered by drag-to-reorder gesture.
  // Pushes history so a single Undo restores the prior order. Peaks Map is rekeyed so
  // already-extracted waveforms move with their segment instead of being thrown away.
  const handleMoveSegment = useCallback((from: number, to: number) => {
    if (from === to) return;
    if (from < 0 || to < 0) return;
    if (from >= segments.length || to >= segments.length) return;

    pushHistory();

    setSegments((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });

    // Labels move with their segments — this is the whole point of stable labels.
    setSegmentLabels((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });

    setPeaks((prev) => {
      // Rebuild as an array indexed by current order, splice, then rekey to new order.
      const arr = Array.from({ length: segments.length }, (_, i) => prev.get(i) ?? null);
      const [movedPeaks] = arr.splice(from, 1);
      arr.splice(to, 0, movedPeaks);
      const next = new Map<number, number[]>();
      arr.forEach((p, i) => { if (p) next.set(i, p); });
      return next;
    });

    setPeakErrors((prev) => {
      const arr = Array.from({ length: segments.length }, (_, i) => prev.has(i));
      const [movedErr] = arr.splice(from, 1);
      arr.splice(to, 0, movedErr);
      const next = new Set<number>();
      arr.forEach((e, i) => { if (e) next.add(i); });
      return next;
    });

    setSelectedIndex((cur) => {
      if (cur === from) return to;
      if (from < cur && to >= cur) return cur - 1;
      if (from > cur && to <= cur) return cur + 1;
      return cur;
    });

    setHasChanges(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  }, [segments, pushHistory]);

  // Compute target index from a finger drop. Uses tabLayoutsRef populated by per-tab
  // onLayout; finds the slot whose center is closest to the dropped finger position.
  const commitTabDrop = useCallback((fromIndex: number, finalDeltaX: number) => {
    const layouts = tabLayoutsRef.current;
    const fromLayout = layouts[fromIndex];
    if (!fromLayout) return;
    const fingerCenter = fromLayout.x + fromLayout.width / 2 + finalDeltaX;
    let targetIndex = fromIndex;
    let bestDist = Infinity;
    for (let i = 0; i < segments.length; i++) {
      const lay = layouts[i];
      if (!lay) continue;
      const center = lay.x + lay.width / 2;
      const dist = Math.abs(center - fingerCenter);
      if (dist < bestDist) {
        bestDist = dist;
        targetIndex = i;
      }
    }
    handleMoveSegment(fromIndex, targetIndex);
  }, [segments.length, handleMoveSegment]);

  // Merge segment N with segment N+1 — the round-trip operation for Split. Uses
  // concatenateAudio (AAC stream-copy, near-instant) and shifts subsequent indices
  // down by one. Pushes history so a single Undo restores the pre-merge state.
  const handleMergeWithNext = useCallback((index: number) => {
    if (isTrimming) return;
    if (index < 0 || index >= segments.length - 1) return;
    const a = segments[index];
    const b = segments[index + 1];
    if (!a || !b) return;

    pause();
    pushHistory();
    setIsTrimming(true);

    (async () => {
      try {
        await audioTempFiles.ensureDir();
        const out = audioTempFiles.getConcatOutputPath();
        const result = await concatenateAudio([a.uri, b.uri], out);

        setSegments((prev) => {
          const next = [...prev];
          next.splice(index, 2, {
            uri: result.uri,
            duration: result.duration,
            // Take the louder of the two so silent-upload guard stays conservative
            peakMetering: Math.max(
              a.peakMetering ?? -Infinity,
              b.peakMetering ?? -Infinity
            ),
          });
          // Only delete editor-produced files; never touch caller-owned input URIs
          for (const uri of [a.uri, b.uri]) {
            if (!inputUrisRef.current.has(uri)) safeDeleteFile(uri);
          }
          return next;
        });

        // Merge produces one new segment in place of two — give it a fresh max+1 label
        // so the user can see "this one is the result of a merge"
        setSegmentLabels((prev) => {
          const nextLabel = (prev.length > 0 ? Math.max(...prev) : 0) + 1;
          const next = [...prev];
          next.splice(index, 2, nextLabel);
          return next;
        });

        // Peaks for merged index and everything after are stale (indices shifted)
        setPeaks((prev) => {
          const next = new Map(prev);
          for (const k of Array.from(next.keys())) if (k >= index) next.delete(k);
          return next;
        });
        setPeakErrors((prev) => {
          const next = new Set(prev);
          for (const k of Array.from(next)) if (k >= index) next.delete(k);
          return next;
        });

        setSelectedIndex(index);
        setTrimStart(0);
        setTrimEnd(result.duration);
        setHasChanges(true);

        loadSource(result.uri).catch(() => {});

        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      } catch (error) {
        if (__DEV__) console.error('[Editor] merge failed:', error);
        Alert.alert('Merge Failed', 'Could not merge the segments. Please try again.');
      } finally {
        setIsTrimming(false);
      }
    })().catch(() => {
      setIsTrimming(false);
    });
  }, [segments, isTrimming, pause, pushHistory, loadSource]);

  // Split the current segment at the playhead position. Uses the same AAC stream-copy
  // trim path as a regular trim, run twice ([0, playhead] and [playhead, duration]),
  // replacing the segment in place with two new ones. Enables the "cut out the middle"
  // workflow (split → split → long-press-delete middle segment).
  const handleSplitAtPlayhead = useCallback(() => {
    if (!selectedSegment || isTrimming) return;
    const playhead = currentTimeRef.current ?? 0;
    const dur = selectedSegment.duration;
    const MIN_EDGE = 0.5;
    if (playhead < MIN_EDGE || playhead > dur - MIN_EDGE) {
      Alert.alert('Split Not Possible', 'Move the playhead at least 0.5 s from either end before splitting.');
      return;
    }

    pause();
    pushHistory();
    setIsTrimming(true);
    const indexAtSplit = selectedIndex;

    (async () => {
      try {
        await audioTempFiles.ensureDir();
        const outA = audioTempFiles.getTrimOutputPath(indexAtSplit, 'a');
        const outB = audioTempFiles.getTrimOutputPath(indexAtSplit, 'b');
        const resultA = await trimAudio(selectedSegment.uri, 0, playhead, outA);
        const resultB = await trimAudio(selectedSegment.uri, playhead, dur, outB);

        setSegments((prev) => {
          const next = [...prev];
          const oldUri = next[indexAtSplit]?.uri;
          next.splice(indexAtSplit, 1, {
            uri: resultA.uri,
            duration: resultA.duration,
            peakMetering: selectedSegment.peakMetering,
          }, {
            uri: resultB.uri,
            duration: resultB.duration,
            peakMetering: selectedSegment.peakMetering,
          });
          // Only delete editor-produced temp files. Caller-owned URIs (original recording /
          // stash files) are cleaned up by record.tsx's setResultCallback after Done.
          if (oldUri && !inputUrisRef.current.has(oldUri)) {
            safeDeleteFile(oldUri);
          }
          return next;
        });

        // Split: first half keeps original label; second half gets max+1 fresh number
        setSegmentLabels((prev) => {
          const originalLabel = prev[indexAtSplit] ?? indexAtSplit + 1;
          const nextLabel = (prev.length > 0 ? Math.max(...prev) : 0) + 1;
          const next = [...prev];
          next.splice(indexAtSplit, 1, originalLabel, nextLabel);
          return next;
        });

        // Peaks for both new indices are stale — clear everything from the split point on
        setPeaks((prev) => {
          const next = new Map(prev);
          for (const key of Array.from(next.keys())) {
            if (key >= indexAtSplit) next.delete(key);
          }
          return next;
        });
        setPeakErrors((prev) => {
          const next = new Set(prev);
          for (const key of Array.from(next)) {
            if (key >= indexAtSplit) next.delete(key);
          }
          return next;
        });

        // Stay on the first half after split — handles reset to full range of new segment
        setSelectedIndex(indexAtSplit);
        setTrimStart(0);
        setTrimEnd(resultA.duration);
        setHasChanges(true);

        loadSource(resultA.uri).catch(() => {});

        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      } catch (error) {
        if (__DEV__) console.error('[Editor] split failed:', error);
        Alert.alert('Split Failed', 'Could not split the recording. Please try again.');
      } finally {
        setIsTrimming(false);
      }
    })().catch(() => {
      setIsTrimming(false);
    });
  }, [selectedSegment, selectedIndex, isTrimming, pause, currentTimeRef, loadSource, pushHistory]);

  // Play All — concatenate every segment to a temp file and play it through so the user
  // can hear the final stitched output before tapping Done. Toggling off (or natural EOF)
  // restores the selected segment as the loaded source.
  const handleStopPlayAll = useCallback(() => {
    pause();
    setIsPlayingAll(false);
    if (playAllUriRef.current) {
      safeDeleteFile(playAllUriRef.current);
      playAllUriRef.current = null;
    }
    const sel = segments[selectedIndex];
    if (sel) loadSource(sel.uri).catch(() => {});
  }, [pause, segments, selectedIndex, loadSource]);

  const handleTogglePlayAll = useCallback(() => {
    if (segments.length < 2 || isTrimming) return;
    if (isPlayingAll) {
      handleStopPlayAll();
      return;
    }
    pause();
    (async () => {
      try {
        await audioTempFiles.ensureDir();
        const out = audioTempFiles.getConcatOutputPath();
        const result = await concatenateAudio(segments.map((s) => s.uri), out);
        playAllUriRef.current = result.uri;
        await loadSource(result.uri);
        // Small delay so loadSource's playbackStatusUpdate lands and isLoaded flips true
        // before we call play() — otherwise expo-audio swallows the play with no source ready.
        setTimeout(() => {
          play();
          setIsPlayingAll(true);
        }, 100);
      } catch (error) {
        if (__DEV__) console.error('[Editor] play all failed:', error);
        Alert.alert('Play All Failed', 'Could not preview the full recording.');
        if (playAllUriRef.current) {
          safeDeleteFile(playAllUriRef.current);
          playAllUriRef.current = null;
        }
      }
    })().catch(() => {});
  }, [segments, isTrimming, isPlayingAll, pause, play, loadSource, handleStopPlayAll]);

  // Auto-stop Play All on natural EOF — when isPlaying flips false and currentTime is at
  // the temp file's duration, the user has heard everything; restore the selected source.
  useEffect(() => {
    if (!isPlayingAll) return;
    if (isPlaying) return;
    if (playerDuration <= 0) return;
    if (currentTimeRef.current >= playerDuration - 0.1) {
      handleStopPlayAll();
    }
  }, [isPlayingAll, isPlaying, playerDuration, currentTimeRef, handleStopPlayAll]);

  // Cleanup play-all temp file on unmount (belt-and-suspenders alongside cleanupAll)
  useEffect(() => {
    return () => {
      if (playAllUriRef.current) {
        safeDeleteFile(playAllUriRef.current);
        playAllUriRef.current = null;
      }
    };
  }, []);

  // Auto-trim leading/trailing silence. Uses already-extracted peaks + detectSilenceBounds
  // (−30 dBFS threshold) to snap the handles. User then reviews visually and taps Apply Trim
  // to commit via FFmpeg — no audio is modified by this action alone.
  const handleTrimSilence = useCallback(() => {
    if (!selectedSegment) return;
    if (currentPeaks.length === 0) {
      Alert.alert('Waveform Not Ready', 'Please wait for the waveform to finish loading.');
      return;
    }
    const bounds = detectSilenceBounds(currentPeaks, selectedSegment.duration);
    if (!bounds) {
      Alert.alert('All Silent', 'This recording appears to be entirely silent and cannot be auto-trimmed.');
      return;
    }
    if (bounds.end - bounds.start < 1) {
      Alert.alert('Too Short', 'Auto-trim would leave less than 1 second of audio.');
      return;
    }
    pushHistory();
    setTrimStart(bounds.start);
    setTrimEnd(bounds.end);
    Haptics.selectionAsync().catch(() => {});
  }, [selectedSegment, currentPeaks, pushHistory]);

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
        <View className="flex-row items-center gap-1">
          <Pressable
            onPress={handleUndo}
            disabled={!canUndo || isTrimming}
            accessibilityRole="button"
            accessibilityLabel="Undo"
            hitSlop={8}
            className="p-2"
          >
            <Undo2 color={canUndo && !isTrimming ? '#44403c' : '#a8a29e'} size={20} />
          </Pressable>
          <Pressable
            onPress={handleRedo}
            disabled={!canRedo || isTrimming}
            accessibilityRole="button"
            accessibilityLabel="Redo"
            hitSlop={8}
            className="p-2"
          >
            <Redo2 color={canRedo && !isTrimming ? '#44403c' : '#a8a29e'} size={20} />
          </Pressable>
          <Button
            variant="primary"
            size="sm"
            onPress={handleDone}
            disabled={isTrimming}
          >
            Done
          </Button>
        </View>
      </View>

      {/* Segment tabs — outside ScrollView so horizontal scroll doesn't conflict */}
      {segments.length > 1 && (
        <View className="mb-4 px-5" style={{ maxWidth: 600, alignSelf: 'center', width: '100%' }}>
          <Text className="text-body-sm font-semibold text-stone-600 mb-2">
            Segments ({segments.length}) · Total {formatTime(totalDuration)}
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            scrollEnabled={!isDraggingTab}
          >
            <View className="flex-row items-center gap-2 py-2">
              {segments.map((seg, i) => (
                <React.Fragment key={seg.uri}>
                  <SegmentTab
                    index={i}
                    label={segmentLabels[i] ?? i + 1}
                    segment={seg}
                    isSelected={i === selectedIndex}
                    isOnly={segments.length === 1}
                    disabled={isTrimming}
                    onSelect={() => {
                      // If play-all was running, tear it down first so the existing
                      // selectedUri effect can load the newly-selected segment instead.
                      if (isPlayingAll) {
                        pause();
                        setIsPlayingAll(false);
                        if (playAllUriRef.current) {
                          safeDeleteFile(playAllUriRef.current);
                          playAllUriRef.current = null;
                        }
                      } else {
                        pause();
                      }
                      setSelectedIndex(i);
                    }}
                    onDelete={() => {
                      Haptics.selectionAsync().catch(() => {});
                      handleDeleteSegment(i);
                    }}
                    onLayoutTab={(idx, x, width) => {
                      tabLayoutsRef.current[idx] = { x, width };
                    }}
                    draggingIndexSV={draggingIndexSV}
                    dragTranslationXSV={dragTranslationXSV}
                    targetIndexSV={targetIndexSV}
                    draggedTabWidthSV={draggedTabWidthSV}
                    onLiveDragChange={updateDragTarget}
                    onDropEnd={commitTabDrop}
                  />
                  {i < segments.length - 1 && (
                    <Pressable
                      onPress={() => handleMergeWithNext(i)}
                      disabled={isTrimming}
                      accessibilityRole="button"
                      accessibilityLabel={`Merge segment ${segmentLabels[i] ?? i + 1} with segment ${segmentLabels[i + 1] ?? i + 2}`}
                      accessibilityHint="Combines two adjacent segments into one"
                      hitSlop={6}
                      className="w-7 h-7 items-center justify-center"
                    >
                      <ArrowLeftRight size={16} color="#0d8775" strokeWidth={2.5} />
                    </Pressable>
                  )}
                </React.Fragment>
              ))}
            </View>
          </ScrollView>
        </View>
      )}

      {/* Waveform editor — OUTSIDE ScrollView so gestures have no competition */}
      {/* px-7 (28dp) keeps the left trim handle clear of Android's ~20dp back gesture zone */}
      <View
        className="mb-4 px-7"
        style={{ maxWidth: 600, alignSelf: 'center', width: '100%' }}
        onLayout={(e) => setWaveformContainerWidth(e.nativeEvent.layout.width - 56)}
      >
        {/* Error banner above the editor — the editor itself stays mounted with empty
            peaks so trim handles remain draggable over the grey placeholder bar.
            Previously this branch replaced the editor, leaving the user with no way
            to trim by time despite the copy promising they could. */}
        {hasPeakError && !isPeaksLoading && (
          <View className="rounded-lg bg-stone-100 p-3 mb-2 flex-row items-center justify-between">
            <Text className="text-body-sm text-stone-600 flex-1 pr-2">
              Could not load waveform. You can still trim by time.
            </Text>
            <Button variant="secondary" size="sm" onPress={handleRetryPeaks}>
              Retry
            </Button>
          </View>
        )}
        <WaveformEditor
          peaks={hasPeakError && !isPeaksLoading ? [] : currentPeaks}
          duration={selectedSegment?.duration ?? 0}
          currentTimeSV={currentTimeSV}
          trimStart={trimStart}
          trimEnd={trimEnd}
          trimStartSV={trimStartSV}
          trimEndSV={trimEndSV}
          onTrimChange={handleTrimChange}
          onSeek={handleSeek}
          onScrubStart={handleScrubStart}
          onScrubEnd={handleScrubEnd}
          onHandleActivate={handleHandleActivate}
          isLoading={isPeaksLoading}
        />
      </View>

      {/* Nudge row — frame-accurate adjustment of the last-touched trim handle. Four buttons
          (-1s, -100ms, +100ms, +1s). Long-press repeats. Target label mirrors
          lastActiveHandleRef so the user sees which handle is about to move.
          Visible while peaks are still extracting so long recordings on weak hardware
          (A7 Lite) can be trimmed without waiting — trim math does not depend on peaks. */}
      {selectedSegment && (
        <View
          className="mb-4 px-5 flex-row items-center justify-center gap-2"
          style={{ maxWidth: 600, alignSelf: 'center', width: '100%' }}
        >
          <Text className="text-caption text-stone-500 mr-2">
            Nudge {nudgeTarget === 'start' ? 'start' : 'end'}:
          </Text>
          {[
            { label: `-${nudgeSteps.coarse}s`, delta: -nudgeSteps.coarse },
            { label: `-${nudgeSteps.fine}s`, delta: -nudgeSteps.fine },
            { label: `+${nudgeSteps.fine}s`, delta: nudgeSteps.fine },
            { label: `+${nudgeSteps.coarse}s`, delta: nudgeSteps.coarse },
          ].map(({ label, delta }) => (
            <Pressable
              key={label}
              onPress={() => nudgeHandle(delta)}
              onLongPress={() => startNudgeRepeat(delta)}
              onPressOut={stopNudgeRepeat}
              disabled={isTrimming}
              accessibilityRole="button"
              accessibilityLabel={`Nudge ${nudgeTarget} ${label}`}
              hitSlop={6}
              className="px-3 py-2 rounded-lg bg-stone-200"
            >
              <Text className="text-body-sm font-semibold text-stone-700 text-center" style={{ fontVariant: ['tabular-nums'] }}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {/* Everything below the waveform can scroll on small screens */}
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-5 pb-8"
        contentContainerStyle={{ maxWidth: 600, alignSelf: 'center', width: '100%' }}
        showsVerticalScrollIndicator={false}
      >
        {/* Play All — preview the final stitched output before tapping Done. Only relevant
            with multiple segments; concatenates to a temp file via FFmpeg stream-copy. */}
        {segments.length > 1 && (
          <View className="items-center mb-3">
            <Pressable
              onPress={handleTogglePlayAll}
              disabled={isTrimming}
              accessibilityRole="button"
              accessibilityLabel={isPlayingAll ? 'Stop playing all segments' : 'Play all segments end to end'}
              hitSlop={6}
              className={`flex-row items-center gap-2 px-4 py-2 rounded-full ${
                isPlayingAll ? 'bg-brand-600' : 'bg-stone-200'
              }`}
            >
              {isPlayingAll
                ? <StopCircle size={16} color="#ffffff" />
                : <ListMusic size={16} color="#0d8775" />
              }
              <Text className={`text-body-sm font-semibold ${
                isPlayingAll ? 'text-white' : 'text-brand-700'
              }`}>
                {isPlayingAll ? 'Stop' : 'Play All'}
              </Text>
            </Pressable>
          </View>
        )}

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

        {/* Current time display — isolated component, re-renders only once per second.
            During Play All the loaded source is the concat temp file, so use totalDuration. */}
        <PlaybackTimeDisplay
          currentTimeSV={currentTimeSV}
          duration={isPlayingAll ? totalDuration : (selectedSegment?.duration ?? 0)}
        />
        {isPreviewMode && (
          <Text className="text-center text-caption text-brand-600 font-medium mb-4">
            Looping trim region
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
                  onPress={togglePreview}
                  disabled={isTrimming || isAtFullRange}
                >
                  {isPreviewMode ? 'Stop Preview' : 'Preview Trim'}
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
                  onPress={handleSplitAtPlayhead}
                  disabled={isTrimming}
                >
                  Split at Playhead
                </Button>
                <Button
                  variant="ghost"
                  onPress={handleTrimSilence}
                  disabled={isTrimming || currentPeaks.length === 0}
                >
                  Trim Silence (auto)
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
