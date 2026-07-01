/**
 * Best-effort battery-optimization setup for durable recording reliability.
 *
 * OEM battery killers cannot be fully prevented (plan: Background Recording
 * Reliability); durability + recovery is the guarantee. This nudges the user
 * toward the low-risk battery-optimization SETTINGS screen. It defaults to
 * ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS (no special permission). The
 * direct ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS prompt + permission are
 * intentionally NOT used unless product/legal approves it for managed tablets.
 *
 * Never crashes if the intent is absent on a given OEM.
 */
import { Linking, Platform } from 'react-native';

const IGNORE_BATTERY_OPT_SETTINGS = 'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS';

/**
 * Open the OS battery-optimization settings list (Android only). Returns true if
 * the intent was dispatched. Best-effort — swallows any failure.
 */
export async function openBatteryOptimizationSettings(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    // sendIntent throws if the action is unavailable on this OEM — caught below.
    await Linking.sendIntent(IGNORE_BATTERY_OPT_SETTINGS);
    return true;
  } catch {
    // Fall back to the generic app settings page so the user can still act.
    try {
      await Linking.openSettings();
      return true;
    } catch {
      return false;
    }
  }
}
