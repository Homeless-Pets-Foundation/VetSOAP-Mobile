import * as Clipboard from 'expo-clipboard';
import { AppState } from 'react-native';

const CLIPBOARD_CLEAR_DELAY_MS = 30_000; // 30 seconds

let clearTimer: ReturnType<typeof setTimeout> | null = null;
let pendingText: string | null = null;

// Clear clipboard when app is backgrounded (PHI should not linger)
AppState.addEventListener('change', (state) => {
  if (state !== 'active' && pendingText !== null) {
    Clipboard.setStringAsync('').catch(() => {});
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    pendingText = null;
  }
});

/**
 * Copy sensitive text to clipboard and schedule automatic clearing.
 *
 * Patient health data (SOAP notes) should not linger in the clipboard
 * indefinitely. This utility copies the text and schedules a clear
 * after a configurable timeout.
 */
/** Force-clear any pending clipboard data. Called on sign-out. */
export function clearClipboard(): void {
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
  if (pendingText !== null) {
    Clipboard.setStringAsync('').catch(() => {});
    pendingText = null;
  }
}

export async function copyWithAutoClear(text: string): Promise<void> {
  // Clear any existing timer
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }

  try {
    await Clipboard.setStringAsync(text);
    pendingText = text;
  } catch (error) {
    if (__DEV__) console.error('[Clipboard] setStringAsync failed:', error);
    return;
  }

  // Schedule clipboard clear
  clearTimer = setTimeout(() => {
    (async () => {
      try {
        // Only clear if the clipboard still contains our data.
        // We check by reading and comparing to avoid clearing unrelated content
        // the user may have copied after our text.
        const current = await Clipboard.getStringAsync();
        if (current === text) {
          await Clipboard.setStringAsync('');
        }
      } catch {
        // Clipboard access may fail if app is backgrounded — ignore
      }
      clearTimer = null;
      pendingText = null;
    })().catch(() => {});
  }, CLIPBOARD_CLEAR_DELAY_MS);
}
