import { apiClient } from './client';

export interface DeviceSession {
  id: string;
  deviceId: string;
  deviceName: string | null;
  deviceType: string | null;
  appVersion: string | null;
  lastSeenAt: string;
  createdAt: string;
}

export interface DeviceCapacity {
  count: number;
  limit: number;
  warningThreshold: number;
  remaining: number;
  isAtLimit: boolean;
  isNearLimit: boolean;
}

export interface ListDevicesResponse {
  devices: DeviceSession[];
  capacity: DeviceCapacity;
}

export const devicesApi = {
  list: () => apiClient.get<ListDevicesResponse>('/api/device-sessions'),
  revoke: (id: string) => apiClient.delete<void>(`/api/device-sessions/${id}`),
};
