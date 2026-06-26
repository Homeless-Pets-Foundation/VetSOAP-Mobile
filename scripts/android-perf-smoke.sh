#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="${PACKAGE_NAME:-com.captivet.mobile}"
ACTIVITY_NAME="${ACTIVITY_NAME:-.MainActivity}"
OUT_ROOT="${OUT_ROOT:-/tmp/captivet-perf-smoke}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="${OUT_ROOT}/${TIMESTAMP}"

if [[ -n "${ADB:-}" ]]; then
  ADB_BIN="${ADB}"
elif [[ -x "/mnt/c/Users/jaxnn/AppData/Local/Android/Sdk/platform-tools/adb.exe" ]]; then
  ADB_BIN="/mnt/c/Users/jaxnn/AppData/Local/Android/Sdk/platform-tools/adb.exe"
else
  ADB_BIN="adb"
fi

mkdir -p "${OUT_DIR}"

"${ADB_BIN}" devices | tr -d '\r' > "${OUT_DIR}/adb-devices.txt"
DEVICE_COUNT="$(awk 'NR > 1 && $2 == "device" { count++ } END { print count + 0 }' "${OUT_DIR}/adb-devices.txt")"
if [[ "${DEVICE_COUNT}" -eq 0 ]]; then
  echo "No adb devices are connected." >&2
  cat "${OUT_DIR}/adb-devices.txt" >&2
  exit 1
fi
if [[ -z "${ADB_SERIAL:-}" && "${DEVICE_COUNT}" -gt 1 ]]; then
  echo "Multiple adb devices are connected. Set ADB_SERIAL to the target serial." >&2
  cat "${OUT_DIR}/adb-devices.txt" >&2
  exit 2
fi

ADB_ARGS=()
if [[ -n "${ADB_SERIAL:-}" ]]; then
  ADB_ARGS=(-s "${ADB_SERIAL}")
fi

adb_shell() {
  "${ADB_BIN}" "${ADB_ARGS[@]}" shell "$@"
}

adb_cmd() {
  "${ADB_BIN}" "${ADB_ARGS[@]}" "$@"
}

capture_device_pressure() {
  local label="$1"
  adb_shell "cat /proc/meminfo" > "${OUT_DIR}/meminfo-device-${label}.txt" 2> "${OUT_DIR}/meminfo-device-${label}.err" || true
  adb_shell "cat /proc/swaps" > "${OUT_DIR}/swaps-${label}.txt" 2> "${OUT_DIR}/swaps-${label}.err" || true
  adb_shell "vmstat 1 5" > "${OUT_DIR}/vmstat-${label}.txt" 2> "${OUT_DIR}/vmstat-${label}.err" || true
}

capture_app_state() {
  local label="$1"
  local pid
  pid="$(adb_shell "pidof ${PACKAGE_NAME}" | tr -d '\r' || true)"
  echo "${pid}" > "${OUT_DIR}/pid-${label}.txt"
  adb_shell "dumpsys meminfo ${PACKAGE_NAME}" > "${OUT_DIR}/meminfo-app-${label}.txt" || true
  adb_shell "dumpsys gfxinfo ${PACKAGE_NAME}" > "${OUT_DIR}/gfxinfo-${label}.txt" || true
  if [[ -n "${pid}" ]]; then
    adb_shell "top -H -b -n 1 -p ${pid}" > "${OUT_DIR}/top-threads-${label}.txt" || true
  fi
}

echo "Writing perf smoke output to ${OUT_DIR}"
capture_device_pressure "before"

if ! adb_shell "pm path ${PACKAGE_NAME}" > "${OUT_DIR}/package-path.txt" 2>&1; then
  echo "Package ${PACKAGE_NAME} is not installed on the target device." >&2
  echo "Install an APK/dev client, then rerun this script. Partial output: ${OUT_DIR}" >&2
  exit 3
fi

adb_shell "am force-stop ${PACKAGE_NAME}" > "${OUT_DIR}/force-stop.txt" 2>&1 || true
adb_shell "dumpsys gfxinfo ${PACKAGE_NAME} reset" > "${OUT_DIR}/gfxinfo-reset-before-launch.txt" 2>&1 || true

if ! adb_shell "am start -W -n ${PACKAGE_NAME}/${ACTIVITY_NAME}" > "${OUT_DIR}/launch-cold.txt" 2>&1; then
  echo "Launch failed for ${PACKAGE_NAME}/${ACTIVITY_NAME}. Details: ${OUT_DIR}/launch-cold.txt" >&2
  sed -n '1,80p' "${OUT_DIR}/launch-cold.txt" >&2
  exit 4
fi
sleep "${POST_LAUNCH_WAIT_SECONDS:-8}"
capture_app_state "cold-start"
capture_device_pressure "after-cold-start"

echo "Navigate Home <-> Records and scroll now if desired."
echo "Waiting ${INTERACTION_WINDOW_SECONDS:-20}s before capturing post-interaction metrics."
sleep "${INTERACTION_WINDOW_SECONDS:-20}"

capture_app_state "post-interaction"
capture_device_pressure "post-interaction"

adb_cmd logcat -d -t 1000 > "${OUT_DIR}/logcat-tail.txt" 2>/dev/null || true

echo "Done: ${OUT_DIR}"
