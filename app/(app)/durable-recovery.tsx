import React, { useCallback, useState } from 'react';
import { ScrollView, Text, View, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronLeft, FileClock } from 'lucide-react-native';
import { useAuthUser } from '../../src/hooks/useAuth';
import { useThemeColors } from '../../src/hooks/useThemeColors';
import { useDurableRecoveries } from '../../src/hooks/useDurableRecoveries';
import { durableRecoveryStore } from '../../src/lib/durableAudio/recoveryState';
import { durableTombstone } from '../../src/lib/durableAudio/tombstone';
import { durableActiveStore } from '../../src/lib/durableAudio/activeStore';
import { draftStorage } from '../../src/lib/draftStorage';
import * as durableRecorder from '../../modules/captivet-durable-recorder';
import type { DurableRecordingManifest } from '../../src/lib/durableAudio/manifest';
import type { PatientSlot } from '../../src/types/multiPatient';
import { normalizeUploadIntentId } from '../../src/lib/uploadIntent';
import type { CreateRecording } from '../../src/types';
import { Button } from '../../src/components/ui/Button';
import { Card } from '../../src/components/ui/Card';
import { IconButton } from '../../src/components/ui/IconButton';
import { trackEvent } from '../../src/lib/analytics';

const BLANK_FORM: CreateRecording = {
  pimsPatientId: '',
  patientName: '',
  clientName: '',
  species: '',
  breed: '',
  appointmentType: '',
};

/** Format ms as m:ss, guarding against non-finite values. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Rule 11: guard new Date()/Intl against a torn/stale manifest timestamp. */
function formatSavedAt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return 'Recently';
  try {
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return 'Recently';
  }
}

/** A recovered recording flagged "edit not yet applied" (window-(i) state). */
function isEditNotApplied(m: DurableRecordingManifest): boolean {
  return m.edited === true && m.anchorsPending === true;
}

function manifestToDurableSlot(m: DurableRecordingManifest): PatientSlot {
  // Derive the draft/slot id from the (unique) recordingId, NOT manifest.slotId:
  // Android synthesizes orphan manifests with a constant slotId ("recovered"), so
  // reusing it would make two recovered orphans collide on the same draft key and
  // overwrite each other. recordingId is the per-recording directory name and is
  // always unique + a valid durable id.
  const slotId = m.recordingId;
  return {
    id: slotId,
    uploadIntentId: normalizeUploadIntentId(undefined, slotId),
    uploadKeyOverride: m.uploadKeyOverride ?? null,
    supersededUploadKey: m.supersededUploadKey ?? null,
    uploadRecovery: null,
    formData: { ...BLANK_FORM },
    pimsPatientIdExplicitlyCleared: false,
    audioState: 'stopped',
    segments: [],
    durable: {
      recordingId: m.recordingId,
      codec: 'aac_lc',
      sampleRate: m.sampleRate,
      bitrate: m.bitrate,
      durationMs: m.durationMs,
      peakDb: m.peakDb,
    },
    audioUri: null,
    audioDuration: m.durationMs / 1000,
    uploadStatus: 'pending',
    uploadProgress: 0,
    uploadError: null,
    serverRecordingId: null,
    draftSlotId: slotId,
    serverDraftId: m.serverRecordingId ?? null,
    draftMetadataDirty: false,
    pendingConfirm: null,
  };
}

export default function DurableRecoveryScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const user = useAuthUser();
  const recoveries = useDurableRecoveries();
  const [busyId, setBusyId] = useState<string | null>(null);

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)' as never);
  }, [router]);

  const handleRestore = useCallback(
    async (m: DurableRecordingManifest) => {
      if (!user?.id || busyId) return;
      setBusyId(m.recordingId);
      try {
        // Synthesize a durable draft, then reuse the existing draft-resume path.
        // The draft/slot id is derived from recordingId (see manifestToDurableSlot)
        // so the resume param must match — never the possibly-non-unique slotId.
        await draftStorage.saveDraft(manifestToDurableSlot(m));
        durableRecoveryStore.remove(m.recordingId);
        trackEvent({ name: 'durable_recovery_restored', props: { mode: 'review' } });
        router.replace({ pathname: '/(tabs)/record', params: { draftSlotId: m.recordingId } } as never);
      } catch {
        Alert.alert('Recovery Failed', 'Could not restore this recording. Please try again.');
        setBusyId(null);
      }
    },
    [user?.id, busyId, router],
  );

  const handleDiscard = useCallback(
    (m: DurableRecordingManifest) => {
      if (!user?.id) return;
      Alert.alert(
        'Discard Recording?',
        'This permanently deletes the recovered recording. This cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Discard',
            style: 'destructive',
            onPress: () => {
              (async () => {
                setBusyId(m.recordingId);
                try {
                  await durableRecorder.discard({ userId: user.id, recordingId: m.recordingId }).catch(() => {});
                  await durableActiveStore.clearActive(m.recordingId).catch(() => {});
                  await durableTombstone.remove(m.recordingId).catch(() => {});
                  durableRecoveryStore.remove(m.recordingId);
                  trackEvent({ name: 'durable_recovery_discarded', props: {} });
                } finally {
                  setBusyId(null);
                }
              })().catch(() => setBusyId(null));
            },
          },
        ],
      );
    },
    [user?.id],
  );

  return (
    <SafeAreaView className="flex-1 bg-surface" edges={['top', 'bottom']}>
      <View className="flex-row items-center gap-2 px-4 py-3">
        <IconButton label="Go back" onPress={goBack} icon={<ChevronLeft size={24} color={colors.contentBody} />} />
        <Text className="text-display font-semibold text-content-primary">Recovered Recordings</Text>
      </View>
      <ScrollView contentContainerClassName="px-4 pb-8 gap-3">
        <Text className="text-content-tertiary mb-2">
          Captivet recovered {recoveries.length === 1 ? 'an unsaved local recording' : `${recoveries.length} unsaved local recordings`}.
          Add patient details, then review and submit — or discard.
        </Text>
        {recoveries.length === 0 && (
          <Card className="p-4">
            <Text className="text-content-tertiary">No recordings to recover.</Text>
          </Card>
        )}
        {recoveries.map((m) => {
          const editPending = isEditNotApplied(m);
          const busy = busyId === m.recordingId;
          return (
            <Card key={m.recordingId} className="p-4 gap-2">
              <View className="flex-row items-center gap-2">
                <FileClock size={18} color={colors.contentTertiary} />
                <Text className="text-content-primary font-medium">Unsaved recording · {formatDuration(m.durationMs)}</Text>
              </View>
              <Text className="text-content-tertiary text-body-sm">Recorded {formatSavedAt(m.updatedAt)}</Text>
              {editPending && (
                <Text className="text-status-danger text-body-sm">
                  Edit not yet applied — re-apply your edit before submitting, or submit the original audio.
                </Text>
              )}
              <View className="flex-row gap-2 mt-1">
                <Button variant="primary" onPress={() => handleRestore(m)} loading={busy} className="flex-1">
                  {editPending ? 'Re-edit' : 'Review & Submit'}
                </Button>
                <Button variant="dangerGhost" onPress={() => handleDiscard(m)} disabled={busy}>
                  Discard
                </Button>
              </View>
            </Card>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}
