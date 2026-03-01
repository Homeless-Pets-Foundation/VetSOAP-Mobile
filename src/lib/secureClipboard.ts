import * as Clipboard from 'expo-clipboard';

const CLIPBOARD_CLEAR_DELAY_MS = 60_000; // 1 minute

let clearTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Copy sensitive text to clipboard and schedule automatic clearing.
 *
 * Patient health data (SOAP notes) should not linger in the clipboard
 * indefinitely. This utility copies the text and schedules a clear
 * after a configurable timeout.
 */
export async function copyWithAutoClear(text: string): Promise<void> {
  // Clear any existing timer
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }

  await Clipboard.setStringAsync(text);

  // Schedule clipboard clear
  clearTimer = setTimeout(async () => {
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
  }, CLIPBOARD_CLEAR_DELAY_MS);
}
