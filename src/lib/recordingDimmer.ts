/**
 * Dims the screen while a recording runs untouched (Android only).
 *
 * The screen stays awake for the whole recording (expo-keep-awake in
 * record.tsx): a foregrounded app is the one budget-tablet battery managers
 * are least likely to kill mid-capture. The backlight is the dominant power
 * draw on those LCD tablets, though, so after RECORDING_DIM_IDLE_MS without a
 * touch the window drops to RECORDING_DIM_LEVEL, and any touch, keyboard use
 * or return to the app restores it.
 *
 * Android only: there `setBrightnessAsync` sets THIS activity's window
 * brightness — no permission, and it can't outlive the app. On iOS it changes
 * the device's system brightness, which would stay dim on the home screen if
 * the app were killed while dimmed, so iOS never dims.
 */
import { AppState, Keyboard, Platform } from 'react-native';

export const RECORDING_DIM_IDLE_MS = 60_000;
export const RECORDING_DIM_LEVEL = 0.15;

export interface BrightnessBridge {
  getBrightnessAsync(): Promise<number>;
  setBrightnessAsync(value: number): Promise<void>;
  restoreSystemBrightnessAsync(): Promise<void>;
}

type Unsubscribe = () => void;

export interface RecordingDimmerDeps {
  /** Returns null when dimming is unsupported (iOS, or the native module is absent). */
  loadBridge: () => BrightnessBridge | null;
  /** Fires on every return to the foreground. */
  subscribeForeground: (onForeground: () => void) => Unsubscribe;
  subscribeKeyboard: (onChange: (open: boolean) => void) => Unsubscribe;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  idleMs?: number;
  level?: number;
}

export interface RecordingDimmer {
  /** A recording started: arm the idle timer. */
  start(): void;
  /** The recording stopped/paused/unmounted: restore brightness, disarm. */
  stop(): void;
  /** The user touched the app: restore brightness and restart the idle timer. */
  noteActivity(): void;
}

export function createRecordingDimmer(deps: RecordingDimmerDeps): RecordingDimmer {
  const idleMs = deps.idleMs ?? RECORDING_DIM_IDLE_MS;
  const level = deps.level ?? RECORDING_DIM_LEVEL;

  let active = false;
  let dimmed = false;
  let keyboardOpen = false;
  let timer: unknown = null;
  // Bumped by every restore/stop so a dim still awaiting the native bridge
  // can tell it was overtaken and undo itself instead of sticking.
  let generation = 0;
  let unsubscribers: Unsubscribe[] = [];

  const clearTimer = () => {
    if (timer !== null) {
      deps.clearTimeout(timer);
      timer = null;
    }
  };

  const restore = () => {
    generation += 1;
    if (!dimmed) return;
    dimmed = false;
    const bridge = deps.loadBridge();
    bridge?.restoreSystemBrightnessAsync().catch(() => {});
  };

  const dim = () => {
    timer = null;
    if (!active || dimmed) return;
    if (keyboardOpen) {
      schedule();
      return;
    }
    const bridge = deps.loadBridge();
    if (!bridge) return;
    const gen = ++generation;
    (async () => {
      const current = await bridge.getBrightnessAsync();
      if (gen !== generation || !active) return;
      // Never BRIGHTEN a screen the vet already turned down.
      if (!(current > level)) return;
      await bridge.setBrightnessAsync(level);
      if (gen !== generation || !active) {
        await bridge.restoreSystemBrightnessAsync();
        return;
      }
      dimmed = true;
    })().catch(() => {});
  };

  function schedule() {
    clearTimer();
    if (!active) return;
    timer = deps.setTimeout(dim, idleMs);
  }

  const noteActivity = () => {
    if (!active) return;
    restore();
    schedule();
  };

  return {
    start() {
      if (active) return;
      if (!deps.loadBridge()) return;
      active = true;
      unsubscribers = [
        deps.subscribeForeground(noteActivity),
        deps.subscribeKeyboard((open) => {
          keyboardOpen = open;
          noteActivity();
        }),
      ];
      schedule();
    },
    stop() {
      if (!active) return;
      active = false;
      clearTimer();
      for (const unsubscribe of unsubscribers) {
        try {
          unsubscribe();
        } catch {
          // ignore
        }
      }
      unsubscribers = [];
      keyboardOpen = false;
      restore();
    },
    noteActivity,
  };
}

let cachedBridge: BrightnessBridge | null | undefined;

// Lazy require (rule 19): a dev-client built before expo-brightness was added
// must not crash at module load — it simply never dims.
function loadAndroidBridge(): BrightnessBridge | null {
  if (Platform.OS !== 'android') return null;
  if (cachedBridge !== undefined) return cachedBridge;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-brightness') as BrightnessBridge;
    cachedBridge =
      typeof mod?.setBrightnessAsync === 'function' &&
      typeof mod?.getBrightnessAsync === 'function' &&
      typeof mod?.restoreSystemBrightnessAsync === 'function'
        ? mod
        : null;
  } catch {
    cachedBridge = null;
  }
  return cachedBridge;
}

export const recordingDimmer = createRecordingDimmer({
  loadBridge: loadAndroidBridge,
  subscribeForeground: (onForeground) => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') onForeground();
    });
    return () => sub.remove();
  },
  subscribeKeyboard: (onChange) => {
    const show = Keyboard.addListener('keyboardDidShow', () => onChange(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => onChange(false));
    return () => {
      show.remove();
      hide.remove();
    };
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

/** Touch handler for app-level containers: any touch counts as activity. */
export function noteRecordingUserActivity(): void {
  recordingDimmer.noteActivity();
}
