import { Platform } from 'react-native';
import { requireNativeModule, type EventSubscription } from 'expo-modules-core';

export type AudioFocusEventType = 'loss' | 'gain';
export type AudioFocusLossReason = 'transient' | 'permanent' | 'duck';

export type AudioFocusEvent = {
  type: AudioFocusEventType;
  reason?: AudioFocusLossReason;
};

type NativeModule = {
  startMonitoring(): Promise<void>;
  stopMonitoring(): Promise<void>;
  addListener(eventName: string, listener: (event: AudioFocusEvent) => void): EventSubscription;
};

const isAndroid = Platform.OS === 'android';

const nativeModule: NativeModule | null = isAndroid
  ? requireNativeModule<NativeModule>('CaptivetAudioFocus')
  : null;

export async function startMonitoring(): Promise<void> {
  if (!nativeModule) return;
  await nativeModule.startMonitoring();
}

export async function stopMonitoring(): Promise<void> {
  if (!nativeModule) return;
  await nativeModule.stopMonitoring();
}

export function addListener(
  listener: (event: AudioFocusEvent) => void,
): EventSubscription {
  if (!nativeModule) return { remove: () => {} } as EventSubscription;
  return nativeModule.addListener('audioFocusChange', listener);
}
