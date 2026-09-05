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
import { Alert, Linking, Platform } from 'react-native';
import { secureStorage } from './secureStorage';
import { BATTERY_OPTIMIZATION_COPY } from '../constants/strings';
import { trackEvent } from './analytics';
import { recordingActivity } from './recordingActivity';

const IGNORE_BATTERY_OPT_SETTINGS = 'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS';

/**
 * "We already asked" marker. Device-scoped, not user-scoped: the OS setting
 * belongs to the device, and a shared clinic tablet must not re-prompt every
 * vet who signs in. Not in secureStorage.clearAll()'s delete allowlist, so it
 * survives sign-out like DEVICE_ID.
 */
const PROMPTED_KEY = 'captivet_battery_opt_prompted';

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

/**
 * Ask once, on Android only, whether to exempt Captivet from battery
 * optimization.
 *
 * Why this exists: Samsung One UI app-sleep and the stock battery optimizer
 * kill the app mid-recording. That kill raises no exception and no native
 * signal, so it never reached Sentry — production showed zero crashes for 90
 * days while recordings were being truncated. Durability and recovery are still
 * the real guarantee (this permission is best-effort and OEMs ignore it), but
 * the nudge is free and removes one common cause.
 *
 * Fires at most once per device and is fully dismissible. A storage failure is
 * treated as "already asked" so a broken Keystore cannot produce a prompt loop.
 *
 * @param afterUncleanExit true when this launch found the previous process
 *   exited mid-capture. That is evidence of an unclean exit, NOT proof the OS
 *   killed us — a reboot or a swipe from Recents looks identical — so the copy
 *   it selects reports the observation and offers this setting conditionally.
 */
export async function maybePromptBatteryOptimization(
  afterUncleanExit = false,
  // True while the user this prompt was built for is still the signed-in user.
  // The callback can be mid-await across a sign-out, and cancelWork cannot stop
  // an already-running one — without this, user A's "your last recording ended
  // unexpectedly" copy is shown to user B, and the device-wide
  // one-shot marker is consumed by a prompt that was never theirs.
  isScopeValid: () => boolean = () => true,
): Promise<void> {
  if (Platform.OS !== 'android') return;
  if (!isScopeValid()) return;
  // Never interrupt a live capture. This task is deferred and can land after the
  // vet has started recording; accepting the prompt then sends the app to
  // Android settings MID-RECORDING — precisely the background transition this
  // nudge exists to make safer. Checked before the one-shot marker is written,
  // so a skipped prompt is genuinely rescheduled on a later mount rather than
  // silently consumed.
  if (recordingActivity.isActive()) {
    trackEvent({ name: 'battery_opt_prompt_deferred', props: {} });
    return;
  }
  let alreadyPrompted: string | null;
  try {
    alreadyPrompted = await secureStorage.getRawItem(PROMPTED_KEY, 'batteryOptPrompted');
  } catch {
    return; // fail closed — never nag on a storage fault
  }
  if (alreadyPrompted) return;
  // Mark BEFORE showing. If the write fails we skip the prompt entirely rather
  // than risk asking on every single launch.
  const marked = await secureStorage
    .setRawItem(PROMPTED_KEY, new Date().toISOString(), 'batteryOptPrompted')
    .catch(() => false);
  if (!marked) return;

  // Recheck: a recording can start while either SecureStore call above is
  // pending, which makes the first check stale. Showing the alert then puts it
  // over a live capture, and accepting it backgrounds the app into Android
  // settings mid-recording — the exact transition this nudge exists to avoid.
  // Release the one-shot marker so the prompt is genuinely rescheduled rather
  // than silently consumed; the marker is still written BEFORE the alert in the
  // path that does show it, so a backgrounded dialog cannot loop.
  if (recordingActivity.isActive() || !isScopeValid()) {
    await secureStorage.deleteRawItem(PROMPTED_KEY, 'batteryOptPrompted').catch(() => {});
    trackEvent({ name: 'battery_opt_prompt_deferred', props: {} });
    return;
  }

  Alert.alert(
    BATTERY_OPTIMIZATION_COPY.title,
    afterUncleanExit ? BATTERY_OPTIMIZATION_COPY.bodyAfterUncleanExit : BATTERY_OPTIMIZATION_COPY.body,
    [
      {
        text: BATTERY_OPTIMIZATION_COPY.dismiss,
        style: 'cancel',
        onPress: () => {
          trackEvent({ name: 'battery_opt_settings_opened', props: { opened: false } });
        },
      },
      {
        text: BATTERY_OPTIMIZATION_COPY.confirm,
        onPress: () => {
          // Alert callbacks are () => void — never hand them a promise (rule 2).
          openBatteryOptimizationSettings()
            .then((opened) => {
              // `opened` means the intent was accepted, NOT that an exemption
              // was granted — the user can press Back immediately, and nothing
              // here reads the exemption state. Reporting this as
              // durable_battery_opt_exemption { granted: true } would corrupt
              // the reliability metric and make later kills look like they
              // happened despite a confirmed exemption.
              trackEvent({ name: 'battery_opt_settings_opened', props: { opened } });
            })
            .catch(() => {});
        },
      },
    ],
  );
}
