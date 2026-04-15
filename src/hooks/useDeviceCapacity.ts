import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from '@react-navigation/native';
import { useAuth } from './useAuth';
import { devicesApi, type DeviceCapacity, type DeviceSession } from '../api/devices';

export interface UseDeviceCapacityResult {
  devices: DeviceSession[];
  capacity: DeviceCapacity | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => Promise<unknown>;
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
export function useDeviceCapacity(): UseDeviceCapacityResult {
  const { user } = useAuth();
  const isTabFocused = useIsFocused();

  const query = useQuery({
    queryKey: ['device-sessions'],
    queryFn: () => devicesApi.list(),
    enabled: !!user,
    refetchInterval: isTabFocused ? 60_000 : false,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  return {
    devices: query.data?.devices ?? [],
    capacity: query.data?.capacity,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: () => query.refetch(),
  };
}
