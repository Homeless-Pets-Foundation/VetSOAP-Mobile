/**
 * Module-level "the biometric lock is engaged" flag (precedent:
 * recordingActivity).
 *
 * Why: AppLockGuard covers the signed-in tree with an overlay instead of
 * unmounting it, so a live recording, an unsaved edit and the navigation
 * stack survive a re-lock. A React Native <Modal> renders in its own native
 * window ABOVE that overlay, though, so modal surfaces (ui/Sheet) read this
 * flag and hide while locked.
 */

type Listener = (locked: boolean) => void;

let locked = false;
const listeners = new Set<Listener>();

export const appLockState = {
  setLocked(next: boolean): void {
    if (locked === next) return;
    locked = next;
    for (const listener of listeners) {
      try {
        listener(locked);
      } catch {
        // A broken subscriber must never break the lock path.
      }
    }
  },

  isLocked(): boolean {
    return locked;
  },

  /** Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
