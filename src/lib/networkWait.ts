import NetInfo from '@react-native-community/netinfo';

/**
 * Resolve as soon as NetInfo reports `isInternetReachable === true`,
 * or after `timeoutMs` regardless. Returns whether we observed online
 * before the cap fired.
 *
 * Rationale: Sentry issue REACT-NATIVE-4 (2026-05-13). A flat
 * setTimeout-based retry fires straight back into a still-offline
 * radio after a WiFi blip. Waiting for the reachability event lets a
 * 5-second WiFi flap recover instead of failing the upload.
 */
export async function waitForNetworkOnline(timeoutMs: number): Promise<boolean> {
  const initial = await NetInfo.fetch().catch(() => null);
  if (initial?.isInternetReachable === true) return true;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (online: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(online);
    };
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (state.isInternetReachable === true) finish(true);
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}
