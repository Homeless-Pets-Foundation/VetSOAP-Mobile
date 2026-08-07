import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from '@react-navigation/native';
import { useAuthDeviceRegistration, useAuthUser } from './useAuth';
import { devicesApi, type DeviceCapacity, type DeviceSession } from '../api/devices';

export interface UseDeviceCapacityResult {
  devices: DeviceSession[];
  capacity: DeviceCapacity | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => Promise<unknown>;
}

export interface UseDeviceCapacityOptions {
  mode?: 'home' | 'manage';
  /**
   * Extra gate ANDed with the normal readiness check. `manage` mode carries a
   * 60s poll, so a caller that is mounted for the whole app lifetime (the
   * device-limit modal) must pass `false` while it is not actually showing —
   * otherwise every signed-in user polls `/api/device-sessions` forever.
   * Defaults to true so existing callers are unaffected.
   */
  enabled?: boolean;
}

/**
 * Shared source of truth for the device-session list + capacity stats.
 * Used by the Home banner, the Manage Devices screen, and the hard-limit
 * modal.
 *
 * Polling is gated on tab focus so the banner stays fresh while the user is
 * actively in the app, but doesn't burn the per-user rate-limit budget when
 * they're elsewhere. 60s cadence — capacity only changes when the user
 * revokes from another device or an admin bumps the org limit, so this is
 * already faster than typical ground-truth.
 */
export function useDeviceCapacity(options: UseDeviceCapacityOptions = {}): UseDeviceCapacityResult {
  const mode = options.mode ?? 'home';
  const callerEnabled = options.enabled ?? true;
  const user = useAuthUser();
  const { deviceRegistrationBlock, deviceRegistrationPending } = useAuthDeviceRegistration();
  const isTabFocused = useIsFocused();
  const canQueryDeviceSessions =
    callerEnabled && !!user && !deviceRegistrationBlock && !deviceRegistrationPending;
  const staleTime = mode === 'manage' ? 30_000 : 5 * 60_000;

  const query = useQuery({
    queryKey: ['device-sessions'],
    queryFn: () => devicesApi.list(),
    enabled: canQueryDeviceSessions,
    // Every `refetch`-ish knob is ANDed with the same gate: a disabled query
    // must not poll, must not refetch on mount, and must not refetch on focus.
    refetchInterval: canQueryDeviceSessions && mode === 'manage' && isTabFocused ? 60_000 : false,
    refetchOnWindowFocus: canQueryDeviceSessions && mode === 'manage',
    refetchOnMount: mode === 'manage' ? 'always' : true,
    staleTime,
  });

  return {
    devices: query.data?.devices ?? [],
    capacity: query.data?.capacity,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => query.refetch(),
  };
}
