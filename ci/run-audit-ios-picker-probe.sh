#!/usr/bin/env bash
set -euo pipefail

probe_dir="$(mktemp -d "$RUNNER_TEMP/captivet-picker-probe.XXXXXX")"
echo "AUDIT_IOS_DIR=$probe_dir" >> "$GITHUB_ENV"
sim_id=''
cleanup() {
  if [[ "$sim_id" =~ ^[A-Fa-f0-9-]{36}$ ]]; then
    xcrun simctl shutdown "$sim_id" >/dev/null 2>&1 || true
    xcrun simctl delete "$sim_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

git diff --exit-code 70095f9951c5e5686106c4d44634d55c255836b7 -- app src modules plugins assets package.json package-lock.json app.config.ts
scutil --get LocalHostName > "$probe_dir/mac-network.txt" || true
/sbin/ifconfig | awk '/inet / {print $2}' >> "$probe_dir/mac-network.txt"
xcrun simctl list runtimes -j > "$probe_dir/runtimes.json"

api="https://api.github.com/repos/$GITHUB_REPOSITORY"
curl --fail --silent --show-error --location --header "Authorization: Bearer $GH_TOKEN" "$api/actions/runs/40794456476" > "$probe_dir/source-run.json"
node -e "const r=require(process.argv[1]); if(r.head_sha!=='feeb9662e63bdf39b5a6a793197342cf8c49eba1'||r.conclusion!=='success')process.exit(1)" "$probe_dir/source-run.json"
curl --fail --silent --show-error --location --header "Authorization: Bearer $GH_TOKEN" "$api/actions/runs/40794456476/artifacts" > "$probe_dir/artifacts.json"
artifact_id="$(node -e "const a=require(process.argv[1]).artifacts.filter(x=>x.name==='captivet-audit-ios-simulator'&&!x.expired);if(a.length!==1)process.exit(1);console.log(a[0].id)" "$probe_dir/artifacts.json")"
curl --fail --silent --show-error --location --header "Authorization: Bearer $GH_TOKEN" "$api/actions/artifacts/$artifact_id/zip" > "$probe_dir/native-app.zip"
unzip -q "$probe_dir/native-app.zip" -d "$probe_dir/source"
mkdir "$probe_dir/app"
tar -xzf "$probe_dir/source/captivet-audit-ios-simulator.tar.gz" -C "$probe_dir/app"
apps=("$probe_dir/app/"*.app)
test "${#apps[@]}" -eq 1
test "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "${apps[0]}/Info.plist")" = com.captivet.mobile.local

npm ci --include=dev
printf '\nmodule.exports.resolver.useWatchman = false;\n' >> metro.config.js
npx expo export:embed --entry-file ci/audit-ios-picker-probe.tsx --platform ios --dev false --bundle-output "${apps[0]}/main.jsbundle" --assets-dest "${apps[0]}" 2>&1 | tee "$probe_dir/probe-bundle.log"
codesign --force --deep --sign - "${apps[0]}"
sim_id="$(xcrun simctl create CaptivetAuditPickerProbe com.apple.CoreSimulator.SimDeviceType.iPhone-16)"
[[ "$sim_id" =~ ^[A-Fa-f0-9-]{36}$ ]]
export AUDIT_SIM_ID="$sim_id"
xcrun simctl boot "$sim_id"
node -e "const r=require('node:child_process').spawnSync('xcrun',['simctl','bootstatus',process.env.AUDIT_SIM_ID,'-b'],{timeout:180000,stdio:'inherit'});process.exit(r.status??1)"
xcrun simctl install "$sim_id" "${apps[0]}"
xcrun simctl launch "$sim_id" com.captivet.mobile.local
container="$(xcrun simctl get_app_container "$sim_id" com.captivet.mobile.local data)"
for attempt in {1..30}; do
  if [[ -f "$container/Documents/captivet-native-picker-probe.json" ]]; then break; fi
  sleep 1
done
cp "$container/Documents/captivet-native-picker-probe.json" "$probe_dir/native-picker-result.json"
xcrun simctl io "$sim_id" screenshot "$probe_dir/native-picker.png"
node -e "const r=require(process.argv[1]);console.log(r);if(!r.managerBeforeImport||!r.managerAfterImport||!r.moduleLoaded||!r.nativeLayout||r.nativeLayout.width<=0||r.nativeLayout.height<=0||r.errorMessage)process.exit(1)" "$probe_dir/native-picker-result.json"
