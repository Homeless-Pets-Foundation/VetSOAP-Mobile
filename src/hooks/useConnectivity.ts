import { useEffect, useState, type MutableRefObject } from 'react';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';

/**
 * `isConnected`-only connectivity subscription.
 *
 * `useNetInfo()` re-renders its owner on EVERY NetInfo emission — on Android
 * that includes signal-strength and connection-detail changes — and the record
 * screen only ever branches on `isConnected`. Re-rendering a 7,000-line screen
 * (and, through it, every mounted slot card) because the cell bars changed is
 * exactly the kind of mid-recording jank an older tablet cannot absorb.
 *
 * The full state is mirrored into a caller-OWNED ref (`mirrorRef`) for
 * telemetry that must read the CURRENT transport from inside pinned-dep
 * callbacks. The ref is declared by the caller, not returned from here, so
 * `react-hooks/exhaustive-deps` still recognises it as a stable `useRef`
 * value — a ref handed back from a custom hook is opaque to the rule and turns
 * every function reading it into a "missing dependency". The listener is
 * synchronous (rule 2) and sets state only when the boolean flips.
 */
export function useConnectivity(mirrorRef?: MutableRefObject<NetInfoState | null>): boolean | null {
  const [isConnected, setIsConnected] = useState<boolean | null>(null);

  useEffect(() => {
    // NetInfo invokes the listener immediately with the current state.
    const unsubscribe = NetInfo.addEventListener((next) => {
      if (mirrorRef) mirrorRef.current = next;
      setIsConnected((prev) => (prev === next.isConnected ? prev : next.isConnected));
    });
    return () => {
      unsubscribe();
    };
  }, [mirrorRef]);

  return isConnected;
}
