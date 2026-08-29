import type { NetworkState } from './analytics';

/**
 * Structural shape of the fields we read off `useNetInfo()` / `NetInfo.fetch()`.
 * Kept local so this module stays dependency-free and unit-testable.
 */
export interface NetInfoLike {
  isConnected?: boolean | null;
  type?: string | null;
}

/**
 * Coarse connection descriptor for telemetry. Deliberately drops SSIDs and
 * carrier names — only the transport bucket leaves the device.
 *
 * The return value must stay inside the server's
 * `z.enum(['wifi','cellular','none','unknown'])`; anything else is a 400 on
 * POST /api/telemetry/client-error.
 *
 * `unknown` legitimately covers two cases: connected over an unrecognized
 * transport (ethernet/vpn/other), and NetInfo not having resolved yet
 * (`isConnected: null` on first render). Both are honest answers — the bug
 * this module was extracted for was reading the value at the WRONG TIME, not
 * deriving it wrongly.
 */
export function networkStateFromNetInfo(
  state: NetInfoLike | null | undefined
): NetworkState {
  if (!state) return 'unknown';
  if (state.isConnected === false) return 'none';
  if (state.type === 'wifi') return 'wifi';
  if (state.type === 'cellular') return 'cellular';
  if (state.isConnected === true) return 'unknown';
  return 'unknown';
}
