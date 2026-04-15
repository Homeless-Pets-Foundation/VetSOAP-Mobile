# Captivet Mobile — Local Machine Notes Example

This file is tracked as a template only. Put machine-specific values in `AGENTS.local.md`, which is gitignored.

## Emulator Testing

Document the local environment here, for example:

- Whether Metro runs in WSL2, macOS, Linux, or native Windows
- Which Android SDK / `adb` binary should be used
- Any port forwarding or proxy requirements
- Preferred emulator name and launch command

### Setup & Launch

1. Start the emulator:
   ```bash
   "<path-to-emulator-binary>" -avd <avd-name> -no-snapshot-load &>/dev/null &
   ```
2. Wait for the emulator to appear:
   ```bash
   "<path-to-adb>" devices
   ```
3. Add ADB reverse if needed:
   ```bash
   "<path-to-adb>" reverse tcp:8081 tcp:8081
   ```
4. Add any host-to-guest port proxy your setup requires.
5. Start Metro:
   ```bash
   npx expo start --clear
   ```
6. Deep-link the app to the dev server if needed:
   ```bash
   "<path-to-adb>" shell am start -a android.intent.action.VIEW -d 'captivet://expo-development-client/?url=<encoded-dev-server-url>'
   ```

If Metro is already using port 8081, clear it first:

```bash
lsof -ti:8081 | xargs kill -9
```

### ADB UI Interaction

Replace `<path-to-adb>` with the correct binary for the current machine.

| Action | Command |
|---|---|
| Screenshot | `<path-to-adb> exec-out screencap -p > /tmp/screen.png` |
| Tap | `<path-to-adb> shell input tap <x> <y>` |
| Swipe/Scroll | `<path-to-adb> shell input swipe <x1> <y1> <x2> <y2> <duration_ms>` |
| Type text | `<path-to-adb> shell input text "hello"` |
| Press back | `<path-to-adb> shell input keyevent KEYCODE_BACK` |
| Dismiss keyboard | `<path-to-adb> shell input keyevent KEYCODE_ESCAPE` |
| UI hierarchy | `<path-to-adb> shell uiautomator dump /sdcard/ui.xml && <path-to-adb> shell cat /sdcard/ui.xml` |

### Finding Tap Coordinates

1. Preferred: `uiautomator dump`, then compute the element center from `bounds="[left,top][right,bottom]"`.
2. Fallback: take a screenshot and estimate against the emulator resolution.

### Launch Shortcut

- App package: `com.captivet.mobile`
- Direct launch:
  ```bash
  <path-to-adb> shell am start -n com.captivet.mobile/.MainActivity
  ```

## Machine-Specific Notes

Keep any workstation-only details here, such as:

- SDK install locations
- ADB aliases or shell functions
- Known emulator issues on this machine
- Required admin commands for local networking
