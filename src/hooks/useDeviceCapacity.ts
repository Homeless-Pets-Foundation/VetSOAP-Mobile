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
  const user = useAuthUser();
  const { deviceRegistrationBlock, deviceRegistrationPending } = useAuthDeviceRegistration();
  const isTabFocused = useIsFocused();
  const canQueryDeviceSessions =
    !!user && !deviceRegistrationBlock && !deviceRegistrationPending;
  const staleTime = mode === 'manage' ? 30_000 : 5 * 60_000;

  const query = useQuery({
    queryKey: ['device-sessions'],
    queryFn: () => devicesApi.list(),
    enabled: canQueryDeviceSessions,
    refetchInterval: mode === 'manage' && isTabFocused ? 60_000 : false,
    refetchOnWindowFocus: mode === 'manage',
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
