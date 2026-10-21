import * as Clipboard from 'expo-clipboard';
import { AppState } from 'react-native';

// Long enough to switch to the PIMS / Mail / an authenticator app and paste;
// short enough that a shared clinic tablet doesn't offer the PREVIOUS
// patient's note to the next paste. The risk this guards is a mis-paste into
// the wrong chart, not disclosure (2026-05-29: vet records are not PHI-scoped).
export const CLIPBOARD_CLEAR_DELAY_MS = 120_000; // 2 minutes

let clearTimer: ReturnType<typeof setTimeout> | null = null;
let pendingText: string | null = null;
// Set when the timer expired while the app was not in the foreground. The
// compare-and-clear then runs on the next return to 'active' instead.
let clearDueOnForeground = false;

async function clearIfStillOurs(): Promise<void> {
  const text = pendingText;
  pendingText = null;
  clearDueOnForeground = false;
  if (text === null) return;
  try {
    // Only clear if the clipboard still contains our data, so we never wipe
    // something the user copied elsewhere after our text.
    const current = await Clipboard.getStringAsync();
    if (current === text) {
      await Clipboard.setStringAsync('');
    }
  } catch {
    // Clipboard access can fail on some devices — ignore.
  }
}

// Never clear on the way OUT: leaving the app is how the copied note gets
// pasted into another app. A background app also can't read the clipboard on
// Android 10+, so an expired timer defers its check to the next foreground.
AppState.addEventListener('change', (state) => {
  if (state === 'active' && clearDueOnForeground) {
    clearIfStillOurs().catch(() => {});
  }
});

/** Force-clear any pending clipboard data. Called on sign-out. */
export function clearClipboard(): void {
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
  clearDueOnForeground = false;
  if (pendingText !== null) {
    Clipboard.setStringAsync('').catch(() => {});
    pendingText = null;
  }
}

/**
 * Copy clinical text to the clipboard and schedule a stale-copy clear.
 *
 * The clear fires CLIPBOARD_CLEAR_DELAY_MS after the copy while the app is in
 * the foreground, or on the first return to the foreground after that.
 */
export async function copyWithAutoClear(text: string): Promise<void> {
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
  clearDueOnForeground = false;

  try {
    await Clipboard.setStringAsync(text);
    pendingText = text;
  } catch (error) {
    if (__DEV__) console.error('[Clipboard] setStringAsync failed:', error);
    return;
  }

  clearTimer = setTimeout(() => {
    clearTimer = null;
    if (AppState.currentState === 'active') {
      clearIfStillOurs().catch(() => {});
    } else {
      clearDueOnForeground = true;
    }
  }, CLIPBOARD_CLEAR_DELAY_MS);
}
