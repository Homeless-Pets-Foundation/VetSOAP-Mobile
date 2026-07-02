/**
 * Module-level observable store for the durable-recovery OFFER list.
 *
 * Kept out of the AuthProvider React context on purpose: the launch scan is a
 * side-effecting bounded list, and a standalone store lets Home/Record badges
 * and the recovery screen subscribe (useSyncExternalStore) without threading a
 * new field through AuthProvider's several context objects. AuthProvider owns
 * WHEN the scan runs (post-setUserId one-shot); this owns the result.
 */
import type { DurableRecordingManifest } from './manifest';

let list: DurableRecordingManifest[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* a listener throwing must not break the others */
    }
  }
}

export const durableRecoveryStore = {
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
  getSnapshot(): DurableRecordingManifest[] {
    return list;
  },
  set(next: DurableRecordingManifest[]): void {
    list = next;
    emit();
  },
  /** Remove one offer once it has been resumed / reviewed / discarded / stashed. */
  remove(recordingId: string): void {
    const next = list.filter((m) => m.recordingId !== recordingId);
    if (next.length !== list.length) {
      list = next;
      emit();
    }
  },
  clear(): void {
    if (list.length > 0) {
      list = [];
      emit();
    }
  },
};
