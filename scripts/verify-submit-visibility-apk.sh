#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="${PACKAGE_NAME:-com.captivet.mobile}"
ACTIVITY_NAME="${ACTIVITY_NAME:-.MainActivity}"
APK_PATH="${APK_PATH:-android/app/build/outputs/apk/release/app-release.apk}"
OUT_ROOT="${OUT_ROOT:-/tmp/captivet-submit-visibility}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="${OUT_ROOT}/${TIMESTAMP}"
MANUAL_FLOW="${MANUAL_FLOW:-0}"
START_EMULATOR_AVD="${START_EMULATOR_AVD:-}"
EMULATOR_BIN="${EMULATOR_BIN:-/mnt/c/Users/jaxnn/AppData/Local/Android/Sdk/emulator/emulator.exe}"

if [[ -n "${ADB:-}" ]]; then
  ADB_BIN="${ADB}"
elif [[ -x "/mnt/c/Users/jaxnn/AppData/Local/Android/Sdk/platform-tools/adb.exe" ]]; then
  ADB_BIN="/mnt/c/Users/jaxnn/AppData/Local/Android/Sdk/platform-tools/adb.exe"
else
  ADB_BIN="adb"
fi

mkdir -p "${OUT_DIR}"

if [[ ! -f "${APK_PATH}" ]]; then
  echo "APK not found: ${APK_PATH}" >&2
  echo "Build it first, for example:" >&2
  echo "  cd android && APP_VARIANT=production SENTRY_DISABLE_AUTO_UPLOAD=true ./gradlew :app:assembleRelease" >&2
  exit 2
fi

if [[ -n "${START_EMULATOR_AVD}" ]]; then
  if [[ ! -x "${EMULATOR_BIN}" ]]; then
    echo "Cannot start emulator; EMULATOR_BIN is not executable: ${EMULATOR_BIN}" >&2
    exit 3
  fi
  "${EMULATOR_BIN}" -avd "${START_EMULATOR_AVD}" -no-window -no-snapshot-load \
    > "${OUT_DIR}/emulator.log" 2>&1 &
  echo "$!" > "${OUT_DIR}/emulator.pid"
fi

"${ADB_BIN}" start-server > "${OUT_DIR}/adb-start-server.txt" 2>&1 || true

DEVICE_COUNT=0
for i in {1..90}; do
  # Windows emulator sometimes advertises ADB on 5555 but does not appear until
  # explicitly connected from WSL. Retry because a just-started AVD takes time
  # to open the port.
  "${ADB_BIN}" connect 127.0.0.1:5555 > "${OUT_DIR}/adb-connect-5555-${i}.txt" 2>&1 || true
  "${ADB_BIN}" devices -l | tr -d '\r' > "${OUT_DIR}/adb-devices.txt"
  DEVICE_COUNT="$(awk 'NR > 1 && $2 == "device" { count++ } END { print count + 0 }' "${OUT_DIR}/adb-devices.txt")"
  if [[ "${DEVICE_COUNT}" -gt 0 ]]; then
    break
  fi
  sleep 2
done

if [[ "${DEVICE_COUNT}" -eq 0 ]]; then
  echo "No adb device is connected." >&2
  cat "${OUT_DIR}/adb-devices.txt" >&2
  echo "Output directory: ${OUT_DIR}" >&2
  exit 4
fi

if [[ -z "${ADB_SERIAL:-}" ]]; then
  ADB_SERIAL="$(awk 'NR > 1 && $2 == "device" { print $1; exit }' "${OUT_DIR}/adb-devices.txt")"
fi

ADB_ARGS=(-s "${ADB_SERIAL}")

adb_cmd() {
  "${ADB_BIN}" "${ADB_ARGS[@]}" "$@"
}

adb_shell() {
  adb_cmd shell "$@"
}

capture_state() {
  local label="$1"
  adb_cmd exec-out screencap -p > "${OUT_DIR}/${label}.png" || true
  adb_shell "uiautomator dump /sdcard/captivet-${label}.xml" \
    > "${OUT_DIR}/${label}-uiautomator-dump.txt" 2>&1 || true
  adb_shell "cat /sdcard/captivet-${label}.xml" \
    > "${OUT_DIR}/${label}.xml" 2> "${OUT_DIR}/${label}.xml.err" || true
  adb_cmd logcat -d -t 1000 > "${OUT_DIR}/${label}-logcat.txt" 2>&1 || true
}

echo "Using adb: ${ADB_BIN}"
echo "Using device: ${ADB_SERIAL}"
echo "Writing evidence to: ${OUT_DIR}"

for i in {1..90}; do
  boot="$(adb_shell "getprop sys.boot_completed" 2>/dev/null | tr -d '\r' || true)"
  if [[ "${boot}" == "1" ]]; then
    break
  fi
  sleep 2
  if [[ "${i}" -eq 90 ]]; then
    echo "Device did not report sys.boot_completed=1." >&2
    exit 5
  fi
done

adb_cmd install -r "${APK_PATH}" > "${OUT_DIR}/install.txt" 2>&1
adb_shell "pm dump ${PACKAGE_NAME}" > "${OUT_DIR}/package-dump.txt" 2>&1 || true
adb_cmd logcat -c || true
adb_shell "am force-stop ${PACKAGE_NAME}" > "${OUT_DIR}/force-stop.txt" 2>&1 || true
adb_shell "am start -W -n ${PACKAGE_NAME}/${ACTIVITY_NAME}" > "${OUT_DIR}/launch.txt" 2>&1
sleep 3
capture_state "launch"

if grep -Eiq 'FATAL EXCEPTION|AndroidRuntime.*com\.captivet\.mobile' "${OUT_DIR}/launch-logcat.txt"; then
  echo "Launch produced a fatal app log. See ${OUT_DIR}/launch-logcat.txt" >&2
  exit 6
fi

if [[ "${MANUAL_FLOW}" != "1" ]]; then
  echo "Install/launch smoke complete."
  echo "For exact signed-in workflow evidence, rerun with MANUAL_FLOW=1 and perform the Submit All flow on the device."
  exit 0
fi

if [[ ! -t 0 ]]; then
  echo "MANUAL_FLOW=1 requires an interactive terminal for checkpoints." >&2
  exit 7
fi

cat <<'EOF'

Manual signed-in validation:
1. Sign in if needed.
2. Start a 2-patient appointment.
3. Enter only Testgg for patient 1.
4. Record, Finish, Resume after finish, then Pause/Finish again if needed.
5. Switch to patient 2.
6. Enter only Testbb.
7. Record and Finish.
8. Submit All.
9. Stop on the Recordings confirmation/list where both submissions should be visible.

Press Enter after the Recordings screen shows the submitted-session confirmation.
EOF
read -r _

capture_state "submitted"

if ! grep -q "2 of 2 submitted" "${OUT_DIR}/submitted.xml"; then
  echo "Could not verify '2 of 2 submitted' in UI dump." >&2
  echo "Evidence saved to ${OUT_DIR}" >&2
  exit 8
fi

if ! grep -q "Testgg" "${OUT_DIR}/submitted.xml" || ! grep -q "Testbb" "${OUT_DIR}/submitted.xml"; then
  echo "Could not verify both Testgg and Testbb in UI dump." >&2
  echo "Evidence saved to ${OUT_DIR}" >&2
  exit 9
fi

echo "Manual signed-in submit visibility checkpoint passed."
echo "Evidence saved to ${OUT_DIR}"
