import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import { Download } from 'lucide-react-native';
import { Text } from './ui/Text';
import { Button } from './ui/Button';
import { useThemeColors } from '../hooks/useThemeColors';
import { recordingsApi } from '../api/recordings';
import { ApiError } from '../api/client';
import { DownloadManifestValidationError } from '../api/downloadManifest';
import {
  AudioDownloadError,
  downloadAudioManifest,
  waitForAudioDownloadManifest,
  type AudioDownloadErrorCode,
  type AudioDownloadProgress,
} from '../lib/audioDownload';
import {
  fetchAudioDownloadPart,
  isDirectoryPickerCancellation,
  pickAudioDownloadDestination,
} from '../lib/audioDownloadNative';
import { acquireKeepAwakeLease, type KeepAwakeLease } from '../lib/keepAwakeLease';
import { trackEvent } from '../lib/analytics';
import { AUDIO_DOWNLOAD_COPY } from '../constants/strings';
import { withPromiseTimeout } from '../lib/promiseTimeout';

type DownloadPhase = 'idle' | 'selecting' | 'preparing' | 'downloading';
const AUDIO_DOWNLOAD_PICKER_TIMEOUT_MS = 2 * 60 * 1000;

interface RecordingAudioDownloadProps {
  recordingId: string;
  organizationId: string;
  disabled?: boolean;
}

function acquireDownloadKeepAwakeLease(): KeepAwakeLease {
  try {
    // expo-keep-awake is loaded lazily so an older development client can
    // still open the detail screen; a missing module degrades to a no-op.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const keepAwake = require('expo-keep-awake') as typeof import('expo-keep-awake');
    return acquireKeepAwakeLease(
      'captivet-audio-download',
      keepAwake.activateKeepAwakeAsync,
      keepAwake.deactivateKeepAwake
    );
  } catch {
    return acquireKeepAwakeLease('captivet-audio-download', () => {}, () => {});
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function failureCode(error: unknown): AudioDownloadErrorCode {
  if (error instanceof AudioDownloadError) return error.code;
  if (error instanceof DownloadManifestValidationError) return 'manifest_invalid';
  if (
    error instanceof ApiError &&
    ['AUDIO_OBJECT_MISSING', 'INVALID_AUDIO_OBJECT', 'NO_AUDIO', 'AUDIO_NOT_CONFIRMED'].includes(
      error.code ?? ''
    )
  ) {
    return 'source_unavailable';
  }
  if (error instanceof ApiError) return 'manifest_fetch_failed';
  return 'manifest_fetch_failed';
}

export function RecordingAudioDownload({
  recordingId,
  organizationId,
  disabled = false,
}: RecordingAudioDownloadProps) {
  const colors = useThemeColors();
  const [phase, setPhase] = useState<DownloadPhase>('idle');
  const [progress, setProgress] = useState<AudioDownloadProgress | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const handleCancel = useCallback(() => {
    if (!abortRef.current || cancelRequested) return;
    setCancelRequested(true);
    abortRef.current.abort();
  }, [cancelRequested]);

  const handleDownload = useCallback(async () => {
    if (disabled || inFlightRef.current) return;
    inFlightRef.current = true;
    let keepAwake: KeepAwakeLease | null = null;
    let partCount = 0;
    let bytes = 0;
    let started = false;

    if (mountedRef.current) {
      setPhase('selecting');
      setProgress(null);
      setCancelRequested(false);
    }

    try {
      let destination;
      try {
        destination = await withPromiseTimeout(
          pickAudioDownloadDestination(),
          AUDIO_DOWNLOAD_PICKER_TIMEOUT_MS,
          'Audio download folder selection timed out',
          () => new AudioDownloadError('destination_unavailable')
        );
      } catch (error) {
        if (isDirectoryPickerCancellation(error)) return;
        trackEvent({
          name: 'audio_download_failed',
          props: {
            recording_id: recordingId,
            part_count: 0,
            bytes: 0,
            error_code: 'destination_unavailable',
          },
        });
        if (mountedRef.current) {
          Alert.alert(AUDIO_DOWNLOAD_COPY.failedTitle, AUDIO_DOWNLOAD_COPY.failedBody);
        }
        return;
      }

      // The screen may have unmounted while the native directory picker was
      // open. Do not issue a fresh signed manifest for an abandoned action.
      if (!mountedRef.current) return;

      if (mountedRef.current) setPhase('preparing');
      const controller = new AbortController();
      abortRef.current = controller;
      const requestManifest = () =>
        waitForAudioDownloadManifest(
          recordingsApi.getDownloadManifest(recordingId, organizationId),
          controller.signal
        );
      const manifest = await requestManifest();
      if (controller.signal.aborted || !mountedRef.current) {
        throw new AudioDownloadError('cancelled');
      }

      partCount = manifest.files.length;
      bytes = 0;
      started = true;
      trackEvent({
        name: 'audio_download_started',
        props: {
          recording_id: recordingId,
          part_count: partCount,
          bytes: manifest.totalSizeBytes,
        },
      });
      keepAwake = acquireDownloadKeepAwakeLease();
      if (mountedRef.current) {
        setPhase('downloading');
        setProgress({
          bytesWritten: 0,
          totalBytes: manifest.totalSizeBytes,
          partNumber: 1,
          partCount,
        });
      }

      const result = await downloadAudioManifest({
        manifest,
        destination,
        refreshManifest: requestManifest,
        fetchPart: fetchAudioDownloadPart,
        signal: controller.signal,
        onProgress: (next) => {
          bytes = next.bytesWritten;
          if (mountedRef.current) setProgress(next);
        },
      });
      bytes = result.bytesWritten;
      trackEvent({
        name: 'audio_download_completed',
        props: { recording_id: recordingId, part_count: result.partCount, bytes },
      });
      if (mountedRef.current) {
        Alert.alert(
          AUDIO_DOWNLOAD_COPY.completedTitle,
          AUDIO_DOWNLOAD_COPY.completedBody(result.partCount)
        );
      }
    } catch (error) {
      const code = failureCode(error);
      if (code === 'cancelled') {
        if (started) {
          trackEvent({
            name: 'audio_download_cancelled',
            props: { recording_id: recordingId, part_count: partCount, bytes },
          });
        }
        if (
          mountedRef.current &&
          error instanceof AudioDownloadError &&
          error.rollbackIncomplete
        ) {
          Alert.alert(AUDIO_DOWNLOAD_COPY.failedTitle, AUDIO_DOWNLOAD_COPY.rollbackIncompleteBody);
        }
      } else {
        trackEvent({
          name: 'audio_download_failed',
          props: { recording_id: recordingId, part_count: partCount, bytes, error_code: code },
        });
        if (mountedRef.current) {
          Alert.alert(
            AUDIO_DOWNLOAD_COPY.failedTitle,
            code === 'source_unavailable'
              ? AUDIO_DOWNLOAD_COPY.sourceUnavailableBody
              : error instanceof AudioDownloadError && error.rollbackIncomplete
              ? AUDIO_DOWNLOAD_COPY.rollbackIncompleteBody
              : AUDIO_DOWNLOAD_COPY.failedBody
          );
        }
      }
    } finally {
      keepAwake?.release();
      abortRef.current = null;
      inFlightRef.current = false;
      if (mountedRef.current) {
        setPhase('idle');
        setProgress(null);
        setCancelRequested(false);
      }
    }
  }, [disabled, organizationId, recordingId]);

  const isPreparing = phase === 'selecting' || phase === 'preparing';
  const isDownloading = phase === 'downloading';

  return (
    <View className="mt-4 pt-4 border-t border-border-subtle">
      {isDownloading && progress ? (
        <>
          <Text className="text-body-sm text-content-secondary mb-2">
            {cancelRequested
              ? 'Cancelling…'
              : AUDIO_DOWNLOAD_COPY.progress(
                  progress.partNumber,
                  progress.partCount,
                  formatBytes(progress.bytesWritten),
                  formatBytes(progress.totalBytes)
                )}
          </Text>
          <View className="h-1.5 rounded-pill bg-surface-sunken overflow-hidden mb-2">
            <View
              className="h-full rounded-pill bg-brand-500"
              style={{
                width: `${Math.min(
                  100,
                  progress.totalBytes > 0
                    ? (progress.bytesWritten / progress.totalBytes) * 100
                    : 0
                )}%`,
              }}
            />
          </View>
          <Button
            variant="dangerGhost"
            size="sm"
            disabled={cancelRequested}
            onPress={handleCancel}
          >
            {AUDIO_DOWNLOAD_COPY.cancel}
          </Button>
        </>
      ) : (
        <Button
          variant="secondary"
          size="sm"
          loading={isPreparing}
          disabled={disabled || isPreparing}
          icon={<Download size={17} color={colors.contentBody} />}
          onPress={() => {
            handleDownload().catch(() => {});
          }}
        >
          {AUDIO_DOWNLOAD_COPY.action}
        </Button>
      )}
      <Text className="text-caption text-content-tertiary mt-2" numberOfLines={4}>
        {disabled
          ? AUDIO_DOWNLOAD_COPY.disabledWhileRecording
          : phase === 'selecting'
            ? AUDIO_DOWNLOAD_COPY.choosingFolder
            : AUDIO_DOWNLOAD_COPY.storageNotice}
      </Text>
    </View>
  );
}
