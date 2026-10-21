import { useSyncExternalStore } from 'react';
import { appLockState } from '../lib/appLockState';

/** True while AppLockGuard's lock overlay covers the signed-in tree. */
export function useAppLocked(): boolean {
  return useSyncExternalStore(
    appLockState.subscribe,
    appLockState.isLocked,
    appLockState.isLocked,
  );
}
