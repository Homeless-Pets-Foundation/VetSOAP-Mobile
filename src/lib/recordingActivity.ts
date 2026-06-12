/**
 * Module-level flag tracking whether a recording session currently owns the
 * recorder (precedent: audioEditorBridge singleton).
 *
 * Why: the Record tab stays mounted across navigations, so a vet mid-recording
 * can open a completed recording's detail screen. If the audio player there
 * initialized, `ensurePlaybackMode()` would call
 * `setAudioModeAsync({ allowsRecording: false })` and reconfigure the audio
 * session out from under the live recorder (rule-6 failure class —
 * recorder+player concurrency is untested). RecordingAudioPlayer renders a
 * disabled card while this flag is set.
 *
 * record.tsx sets/clears it from the `recorderBoundToSlotId` state (covers
 * recording AND paused, both of which still own the recorder).
 */

type Listener = (active: boolean) => void;

let isActive = false;
const listeners = new Set<Listener>();

export const recordingActivity = {
  setActive(next: boolean): void {
    if (isActive === next) return;
    isActive = next;
    for (const listener of listeners) {
      try {
        listener(isActive);
      } catch {
        // A broken subscriber must never break the recorder path.
      }
    }
  },

  isActive(): boolean {
    return isActive;
  },

  /** Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
