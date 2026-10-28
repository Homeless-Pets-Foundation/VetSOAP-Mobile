import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { Text } from './ui/Text';
import { Button } from './ui/Button';
import { useAudioPlayback } from '../hooks/useAudioPlayback';
import { useAppLocked } from '../hooks/useAppLocked';
import { recordingActivity } from '../lib/recordingActivity';
import { audioTempFiles } from '../lib/audioTempFiles';
import { withPromiseTimeout } from '../lib/promiseTimeout';
import { prepareRecoveryPreview, RECOVERY_PREVIEW_MAX_SECONDS } from '../lib/durableAudio/recoveryPreview';
import type { DurableRecordingManifest } from '../lib/durableAudio/manifest';
import { RECOVERY_PREVIEW_COPY } from '../constants/strings';

export function RecoveryAudioPreview({ offer, userId, onStop }: {
  offer: DurableRecordingManifest;
  userId: string;
  onStop: () => void;
}) {
  const locked = useAppLocked();
  const allowed = useCallback(() => !locked && AppState.currentState === 'active' && !recordingActivity.isActive(), [locked]);
  const playback = useAudioPlayback(allowed);
  const { loadSource, pause, isLoaded, isPlaying, currentTimeRef } = playback;
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const currentRef = useRef(false);
  const loadedRef = useRef(isLoaded);
  loadedRef.current = isLoaded;

  useEffect(() => {
    const controller = new AbortController();
    currentRef.current = true;
    let uri: string | undefined;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    setError(false);
    setDuration(0);
    prepareRecoveryPreview(offer, userId, controller.signal)
      .then(async (preview) => {
        uri = preview.uri;
        if (controller.signal.aborted || !allowed()) return;
        setDuration(Math.min(RECOVERY_PREVIEW_MAX_SECONDS, preview.durationSeconds));
        readyTimer = setTimeout(() => {
          if (currentRef.current && !loadedRef.current) { pause(); setError(true); controller.abort(); }
        }, 15_000);
        await withPromiseTimeout(loadSource(preview.uri, controller.signal), 15_000, 'Preview loading timed out');
      })
      .catch(() => { if (!controller.signal.aborted) { pause(); setError(true); controller.abort(); } })
      .finally(() => {
        if (controller.signal.aborted && uri) audioTempFiles.cleanupFile(uri);
      });
    return () => {
      currentRef.current = false;
      controller.abort();
      clearTimeout(readyTimer);
      pause();
      if (uri) audioTempFiles.cleanupFile(uri);
    };
  }, [offer, userId, attempt, loadSource, pause, allowed]);

  useEffect(() => {
    if (!isLoaded || error) return;
    // Poll the existing playback clock; never allow a preview to continue past its limit.
    const timer = setInterval(() => {
      if (!allowed() || currentTimeRef.current >= duration) onStop();
    }, 100);
    return () => clearInterval(timer);
  }, [allowed, currentTimeRef, duration, error, isLoaded, onStop]);

  return (
    <View className="gap-2">
      <Text className="text-body-sm text-content-tertiary">
        {error ? RECOVERY_PREVIEW_COPY.failed : duration > 0
          ? RECOVERY_PREVIEW_COPY.duration(Math.ceil(duration)) : RECOVERY_PREVIEW_COPY.preparing}
      </Text>
      <View className="flex-row flex-wrap gap-2">
        {error ? <Button variant="secondary" size="sm" onPress={() => setAttempt((value) => value + 1)}>{RECOVERY_PREVIEW_COPY.retry}</Button> : (
          <Button variant="secondary" size="sm" disabled={!isLoaded || !allowed()} loading={!isLoaded}
            onPress={() => { if (allowed() && currentRef.current) playback.toggle(); }}>
            {isPlaying ? RECOVERY_PREVIEW_COPY.pause : RECOVERY_PREVIEW_COPY.play}
          </Button>
        )}
        <Button variant="ghost" size="sm" onPress={onStop}>{RECOVERY_PREVIEW_COPY.stop}</Button>
      </View>
    </View>
  );
}
