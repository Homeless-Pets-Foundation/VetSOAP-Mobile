import { useSyncExternalStore } from 'react';
import { durableRecoveryStore } from '../lib/durableAudio/recoveryState';
import type { DurableRecordingManifest } from '../lib/durableAudio/manifest';

/**
 * Subscribe to the durable-recovery OFFER list produced by the launch scan.
 * Drives the Home/Record recovery badge and the recovery screen. Independent of
 * the AuthProvider context (see recoveryState.ts).
 */
export function useDurableRecoveries(): DurableRecordingManifest[] {
  return useSyncExternalStore(
    durableRecoveryStore.subscribe,
    durableRecoveryStore.getSnapshot,
    durableRecoveryStore.getSnapshot,
  );
}
