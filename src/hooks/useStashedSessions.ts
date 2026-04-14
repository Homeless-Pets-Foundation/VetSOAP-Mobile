import { useState, useEffect, useCallback } from 'react';
import { Alert } from 'react-native';
import { stashStorage } from '../lib/stashStorage';
import { stashAudioManager } from '../lib/stashAudioManager';
import { safeDeleteFile } from '../lib/fileOps';
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

export function useStashedSessions(userId: string | null) {
  // Internal state holds the full list from SecureStore, including entries pinned
  // by an active resumed session. The exported `stashes` filters those out so the
  // UI never shows a stash that would cause a double-resume.
  const [allStashes, setAllStashes] = useState<StashedSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const isScopeCurrent = useCallback(
    (scopedUserId: string | null) =>
      scopedUserId !== null &&
      stashStorage.getUserId() === scopedUserId &&
      stashAudioManager.getUserId() === scopedUserId,
    []
  );

  const refreshStashes = useCallback(async () => {
    const scopedUserId = userId;
    if (!scopedUserId || !isScopeCurrent(scopedUserId)) {
      setAllStashes([]);
      return;
    }

    try {
      const sessions = await stashStorage.getStashedSessions();
      if (!isScopeCurrent(scopedUserId)) return;
      setAllStashes(sessions);
    } catch {
      if (!isScopeCurrent(scopedUserId)) return;
      setAllStashes([]);
    }
  }, [userId, isScopeCurrent]);

  // On init: clear any stale `resumedAt` flags (the previous app session may have
  // been killed mid-resume), load stashes, then recover any orphaned directories
  // with recovery manifests.
  useEffect(() => {
    let cancelled = false;
    const scopedUserId = userId;

    if (!userId) {
      setAllStashes([]);
      setIsLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setIsLoading(true);
    (async () => {
      try {
        let sessions = await stashStorage.getStashedSessions();
        if (cancelled || !isScopeCurrent(scopedUserId)) return;

        // Clear stale `resumedAt` flags from a prior app session. The active session
        // that set them is gone (React state did not survive), so the stash should
        // be user-visible again.
        if (sessions.some((s) => s.resumedAt)) {
          const cleared = sessions.map(({ resumedAt: _resumedAt, ...rest }) => rest);
          await stashStorage.saveStashedSessions(cleared);
          if (cancelled || !isScopeCurrent(scopedUserId)) return;
          sessions = cleared;
        }

        setAllStashes(sessions);

        // Recover orphaned stash directories that have recovery manifests.
        // Entries with `resumedAt` count as valid — their dirs must be preserved
        // because the active session is still using them.
        const validIds = sessions.map((s) => s.id);
        const recovered = await stashAudioManager.recoverOrCleanupOrphans(validIds);
        if (cancelled || !isScopeCurrent(scopedUserId)) return;
        if (recovered.length > 0) {
          for (const session of recovered) {
            if (cancelled || !isScopeCurrent(scopedUserId)) return;
            const added = await stashStorage.addStashedSession(session);
            if (cancelled || !isScopeCurrent(scopedUserId)) return;
            if (added) {
              await stashAudioManager.deleteRecoveryManifest(session.id);
            }
          }
          // Refresh to show recovered sessions
          const updated = await stashStorage.getStashedSessions();
          if (cancelled || !isScopeCurrent(scopedUserId)) return;
          setAllStashes(updated);
        }
      } catch {
        if (cancelled || !isScopeCurrent(scopedUserId)) return;
        setAllStashes([]);
      } finally {
        if (cancelled || !isScopeCurrent(scopedUserId)) return;
        setIsLoading(false);
      }
    })().catch(() => {
      if (cancelled || !isScopeCurrent(scopedUserId)) return;
      setIsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [userId, isScopeCurrent]);

  const stashSession = useCallback(
    async (sessionState: SessionState): Promise<boolean> => {
      const scopedUserId = userId;
      if (!scopedUserId || !isScopeCurrent(scopedUserId)) return false;

      try {
        // Only stash slots that have unsubmitted recordings or form data worth saving
        const slotsToStash = sessionState.slots.filter(
          (s) => s.uploadStatus !== 'success'
        );

        if (slotsToStash.length === 0) return false;

        // Safety net: refuse to stash if no slot has any audio segments.
        // This catches the React state timing bug where executeStash runs
        // before SAVE_AUDIO is processed — better to fail visibly than
        // silently stash an empty session and lose the recording.
        const preStashSegmentCount = slotsToStash.reduce((sum, s) => sum + s.segments.length, 0);
        if (preStashSegmentCount === 0) {
          if (__DEV__) console.error('[Stash] no audio segments in any slot — aborting to prevent data loss');
          return false;
        }

        const sessionId = generateId();

        // Move audio files to persistent storage
        const stashedSlots = await stashAudioManager.moveSegmentsToStashDir(
          sessionId,
          slotsToStash
        );
        if (!isScopeCurrent(scopedUserId)) {
          await stashAudioManager.deleteStashedAudio(sessionId);
          return false;
        }

        const totalSegments = stashedSlots.reduce(
          (sum, s) => sum + s.segments.length,
          0
        );

        // Require every segment to copy successfully before we commit the stash.
        // Otherwise keep the active session intact and discard the temporary copy.
        if (totalSegments !== preStashSegmentCount) {
          await stashAudioManager.deleteStashedAudio(sessionId);
          return false;
        }

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

        // Write recovery manifest BEFORE SecureStore — if the app crashes between
        // here and addStashedSession, the manifest allows recovery on next launch
        await stashAudioManager.writeRecoveryManifest(sessionId, stashedSession);
        if (!isScopeCurrent(scopedUserId)) {
          await stashAudioManager.deleteStashedAudio(sessionId);
          return false;
        }

        const saved = await stashStorage.addStashedSession(stashedSession);
        if (!isScopeCurrent(scopedUserId)) return false;
        if (!saved) {
          // Metadata write did not commit, so keep the active session intact and
          // remove the temporary stash copy to avoid duplicate recovery.
          await stashAudioManager.deleteStashedAudio(sessionId);
          return false;
        }

        // SecureStore is now authoritative — remove the old cache copies and
        // clean up the recovery manifest.
        slotsToStash.forEach((slot) => {
          slot.segments.forEach((segment) => {
            safeDeleteFile(segment.uri);
          });
        });
        await stashAudioManager.deleteRecoveryManifest(sessionId);

        await refreshStashes();
        return true;
      } catch (error) {
        if (__DEV__) console.error('[Stash] stashSession failed:', error);
        return false;
      }
    },
    [userId, isScopeCurrent, refreshStashes]
  );

  /**
   * Pin a stash entry after it has been restored into an active session.
   * Keeps the entry (and therefore its audio directory) alive across orphan
   * cleanup sweeps, but hides it from the user-visible list via `resumedAt`.
   * The entry is removed by `releaseResumedStash` when the active session is
   * resolved (uploaded, discarded, or re-stashed). If the app is killed in
   * between, the flag is cleared on next launch so the user can resume again.
   */
  const markResumed = useCallback(
    async (stashId: string): Promise<void> => {
      const scopedUserId = userId;
      if (!scopedUserId || !isScopeCurrent(scopedUserId)) return;

      try {
        const existing = await stashStorage.getStashedSessions();
        if (!isScopeCurrent(scopedUserId)) return;
        const updated = existing.map((s) =>
          s.id === stashId ? { ...s, resumedAt: new Date().toISOString() } : s
        );
        await stashStorage.saveStashedSessions(updated);
        if (!isScopeCurrent(scopedUserId)) return;
        setAllStashes(updated);
      } catch {
        // Best-effort — if the write fails, the next orphan sweep could delete
        // the stash dir. That is still better than the prior behavior (entry
        // already removed and dir definitely orphaned).
      }
    },
    [userId, isScopeCurrent]
  );

  /**
   * Fully remove a resumed stash. Used when the active session derived from it
   * is resolved (upload success, user discard, or re-stash). Deletes both the
   * audio directory and the SecureStore entry.
   */
  const releaseResumedStash = useCallback(
    async (stashId: string): Promise<void> => {
      const scopedUserId = userId;
      if (!scopedUserId || !isScopeCurrent(scopedUserId)) return;

      try {
        await stashAudioManager.deleteStashedAudio(stashId);
        if (!isScopeCurrent(scopedUserId)) return;
        await stashStorage.removeStashedSession(stashId);
        if (!isScopeCurrent(scopedUserId)) return;
        await refreshStashes();
      } catch {
        // Best-effort — next orphan sweep will clean the dir.
      }
    },
    [userId, isScopeCurrent, refreshStashes]
  );

  const resumeSession = useCallback(
    async (stashId: string): Promise<PatientSlot[] | null> => {
      const scopedUserId = userId;
      if (!scopedUserId || !isScopeCurrent(scopedUserId)) return null;

      const convertToPatientSlots = (
        stashedSlots: { id: string; formData: PatientSlot['formData']; segments: { uri: string; duration: number; peakMetering?: number }[]; audioDuration: number }[]
      ): PatientSlot[] => {
        return stashedSlots.map((slot) => ({
          id: slot.id,
          formData: { ...slot.formData },
          audioState: slot.segments.length > 0 ? ('stopped' as const) : ('idle' as const),
          segments: slot.segments.map((s) => ({ uri: s.uri, duration: s.duration, peakMetering: s.peakMetering })),
          audioUri: slot.segments.length > 0 ? slot.segments[slot.segments.length - 1].uri : null,
          audioDuration: slot.audioDuration,
          uploadStatus: 'pending' as const,
          uploadProgress: 0,
          uploadError: null,
          serverRecordingId: null,
          draftSlotId: null,
          serverDraftId: null,
          pendingConfirm: null,
        }));
      };

      try {
        const sessions = await stashStorage.getStashedSessions();
        if (!isScopeCurrent(scopedUserId)) return null;
        const stash = sessions.find((s) => s.id === stashId);
        if (!stash) return null;

        // Validate audio files still exist
        const { validSlots, allValid, missingCount } =
          await stashAudioManager.validateStashedAudio(stash.slots);
        if (!isScopeCurrent(scopedUserId)) return null;

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
                    resolve(convertToPatientSlots(validSlots));
                  },
                },
              ]
            );
          });
        }

        return convertToPatientSlots(validSlots);
      } catch (error) {
        if (__DEV__) console.error('[Stash] resumeSession failed:', error);
        Alert.alert('Resume Failed', 'Could not restore your session.');
        return null;
      }
    },
    [userId, isScopeCurrent, refreshStashes]
  );

  const deleteStash = useCallback(
    async (stashId: string): Promise<void> => {
      const scopedUserId = userId;
      if (!scopedUserId || !isScopeCurrent(scopedUserId)) return;

      try {
        await stashAudioManager.deleteStashedAudio(stashId);
        if (!isScopeCurrent(scopedUserId)) return;
        await stashStorage.removeStashedSession(stashId);
        if (!isScopeCurrent(scopedUserId)) return;
        await refreshStashes();
      } catch (error) {
        if (__DEV__) console.error('[Stash] deleteStash failed:', error);
      }
    },
    [userId, isScopeCurrent, refreshStashes]
  );

  // Hide pinned (resumed) stashes from the user-visible list so a single stash
  // cannot be resumed twice in parallel. Capacity is measured against the full
  // underlying set since SecureStore enforces MAX_STASHES on the total.
  const visibleStashes = allStashes.filter((s) => !s.resumedAt);

  return {
    stashes: visibleStashes,
    isLoading,
    stashCount: visibleStashes.length,
    isAtCapacity: allStashes.length >= 5,
    stashSession,
    resumeSession,
    markResumed,
    releaseResumedStash,
    deleteStash,
    refreshStashes,
  };
}
