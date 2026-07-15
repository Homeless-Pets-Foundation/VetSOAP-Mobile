import { Platform } from 'react-native';
import type { EventSubscription } from 'expo-modules-core';

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

let resolved = false;
let cachedModule: NativeModule | null = null;

/**
 * Resolve lazily so an old or incorrectly packaged native binary cannot crash
 * the app merely by loading the Record route. Android builds that contain the
 * module keep the full audio-focus behavior; missing modules degrade to the
 * recorder's existing interruption handling.
 */
function getNativeModule(): NativeModule | null {
  if (!isAndroid) return null;
  if (resolved) return cachedModule;
  resolved = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const core = require('expo-modules-core') as {
      requireOptionalNativeModule?: <T>(name: string) => T | null;
      requireNativeModule?: <T>(name: string) => T;
    };
    if (typeof core.requireOptionalNativeModule === 'function') {
      cachedModule = core.requireOptionalNativeModule<NativeModule>('CaptivetAudioFocus');
    } else if (typeof core.requireNativeModule === 'function') {
      try {
        cachedModule = core.requireNativeModule<NativeModule>('CaptivetAudioFocus');
      } catch {
        cachedModule = null;
      }
    }
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

export async function startMonitoring(): Promise<void> {
  const nativeModule = getNativeModule();
  if (!nativeModule) return;
  await nativeModule.startMonitoring();
}

export async function stopMonitoring(): Promise<void> {
  const nativeModule = getNativeModule();
  if (!nativeModule) return;
  await nativeModule.stopMonitoring();
}

export function addListener(
  listener: (event: AudioFocusEvent) => void,
): EventSubscription {
  const nativeModule = getNativeModule();
  if (!nativeModule) return { remove: () => {} } as EventSubscription;
  return nativeModule.addListener('audioFocusChange', listener);
}
