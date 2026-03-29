import { useState, useEffect, useCallback } from 'react';
import { Alert } from 'react-native';
import { stashStorage } from '../lib/stashStorage';
import { stashAudioManager } from '../lib/stashAudioManager';
import type { StashedSession } from '../types/stash';
import type { PatientSlot, SessionState } from '../types/multiPatient';

function generateId(): string {
  return `stash-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function buildPatientSummary(slots: PatientSlot[]): string {
  const names = slots
    .map((s) => s.formData.patientName)
    .filter(Boolean);
  if (names.length === 0) return 'No patients';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]}, ${names[1]}`;
  return `${names[0]}, ${names[1]} (+${names.length - 2} more)`;
}

export function useStashedSessions() {
  const [stashes, setStashes] = useState<StashedSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refreshStashes = useCallback(async () => {
    try {
      const sessions = await stashStorage.getStashedSessions();
      setStashes(sessions);
    } catch {
      setStashes([]);
    }
  }, []);

  useEffect(() => {
    refreshStashes().finally(() => {
      setIsLoading(false);
    });
  }, [refreshStashes]);

  const stashSession = useCallback(
    async (sessionState: SessionState): Promise<boolean> => {
      try {
        // Only stash slots that have unsubmitted recordings or form data worth saving
        const slotsToStash = sessionState.slots.filter(
          (s) => s.uploadStatus !== 'success'
        );

        if (slotsToStash.length === 0) return false;

        const sessionId = generateId();

        // Move audio files to persistent storage
        const stashedSlots = await stashAudioManager.moveSegmentsToStashDir(
          sessionId,
          slotsToStash
        );

        const totalSegments = stashedSlots.reduce(
          (sum, s) => sum + s.segments.length,
          0
        );
        const totalDuration = stashedSlots.reduce(
          (sum, s) => sum + s.audioDuration,
          0
        );

        const stashedSession: StashedSession = {
          id: sessionId,
          stashedAt: new Date().toISOString(),
          clientName: slotsToStash[0]?.formData.clientName || 'Unknown Client',
          patientSummary: buildPatientSummary(slotsToStash),
          patientCount: slotsToStash.length,
          totalDuration,
          totalSegments,
          slots: stashedSlots,
        };

        const saved = await stashStorage.addStashedSession(stashedSession);
        if (!saved) {
          // Max stashes reached — shouldn't happen if UI disables button, but guard
          Alert.alert(
            'Stash Limit Reached',
            'You can have up to 5 stashed sessions. Please delete one to make room.'
          );
          // Clean up the moved audio files since we couldn't save
          await stashAudioManager.deleteStashedAudio(sessionId);
          return false;
        }

        await refreshStashes();
        return true;
      } catch (error) {
        if (__DEV__) console.error('[Stash] stashSession failed:', error);
        Alert.alert(
          'Stash Failed',
          'Could not save your session. Your recordings are still active.'
        );
        return false;
      }
    },
    [refreshStashes]
  );

  const resumeSession = useCallback(
    async (stashId: string): Promise<PatientSlot[] | null> => {
      const convertToPatientSlots = async (
        id: string,
        stashedSlots: { id: string; formData: PatientSlot['formData']; segments: { uri: string; duration: number }[]; audioDuration: number }[]
      ): Promise<PatientSlot[]> => {
        const restoredSlots: PatientSlot[] = stashedSlots.map((slot) => ({
          id: slot.id,
          formData: { ...slot.formData },
          audioState: slot.segments.length > 0 ? ('stopped' as const) : ('idle' as const),
          segments: slot.segments.map((s) => ({ uri: s.uri, duration: s.duration })),
          audioUri: slot.segments.length > 0 ? slot.segments[slot.segments.length - 1].uri : null,
          audioDuration: slot.audioDuration,
          uploadStatus: 'pending' as const,
          uploadProgress: 0,
          uploadError: null,
          serverRecordingId: null,
        }));

        // Remove from stash storage (audio files stay — now owned by the session)
        await stashStorage.removeStashedSession(id);
        await refreshStashes();

        return restoredSlots;
      };

      try {
        const sessions = await stashStorage.getStashedSessions();
        const stash = sessions.find((s) => s.id === stashId);
        if (!stash) return null;

        // Validate audio files still exist
        const { validSlots, allValid, missingCount } =
          await stashAudioManager.validateStashedAudio(stash.slots);

        if (!allValid) {
          const totalSegments = stash.slots.reduce(
            (sum, s) => sum + s.segments.length,
            0
          );
          const allMissing = missingCount === totalSegments;

          if (allMissing) {
            Alert.alert(
              'Audio Files Missing',
              'All audio files for this stash have been deleted. The stash will be removed.'
            );
            await stashAudioManager.deleteStashedAudio(stashId);
            await stashStorage.removeStashedSession(stashId);
            await refreshStashes();
            return null;
          }

          // Partial — let user decide
          return new Promise((resolve) => {
            Alert.alert(
              'Some Audio Missing',
              `${missingCount} audio segment(s) could not be found. Resume with available data?`,
              [
                {
                  text: 'Cancel',
                  style: 'cancel',
                  onPress: () => resolve(null),
                },
                {
                  text: 'Resume Anyway',
                  onPress: () => {
                    convertToPatientSlots(stashId, validSlots)
                      .then(resolve)
                      .catch(() => resolve(null));
                  },
                },
              ]
            );
          });
        }

        return await convertToPatientSlots(stashId, validSlots);
      } catch (error) {
        if (__DEV__) console.error('[Stash] resumeSession failed:', error);
        Alert.alert('Resume Failed', 'Could not restore your session.');
        return null;
      }
    },
    [refreshStashes]
  );

  const deleteStash = useCallback(
    async (stashId: string): Promise<void> => {
      try {
        await stashAudioManager.deleteStashedAudio(stashId);
        await stashStorage.removeStashedSession(stashId);
        await refreshStashes();
      } catch (error) {
        if (__DEV__) console.error('[Stash] deleteStash failed:', error);
      }
    },
    [refreshStashes]
  );

  return {
    stashes,
    isLoading,
    stashCount: stashes.length,
    isAtCapacity: stashes.length >= 5,
    stashSession,
    resumeSession,
    deleteStash,
    refreshStashes,
  };
}
