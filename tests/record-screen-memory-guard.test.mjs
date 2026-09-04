/**
 * Fences the Record-screen memory/contention work.
 *
 * Context: the production fleet is Samsung Galaxy Tab A7 Lite tablets (4 GB,
 * Sentry device.class "low"). Android was killing the app mid-recording — a kill
 * that reaches no crash reporter (see tests/process-kill-signal.test.mjs). Sentry
 * showed the contention instead: slow_phase_fetchUser at 14 456 ms against a
 * 10 000 ms threshold, draft_presence_batch_request at 12 723 ms, and
 * init_watchdog_fired with 734 MB free.
 *
 * Each fence below covers a regression that is one plausible edit away.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(path.join(root, p), 'utf8');

/** Resolve a relative TS/TSX specifier the way Metro would. */
function resolveRelative(spec, fromFile) {
  if (!spec.startsWith('.')) return null;
  const base = path.normalize(path.join(path.dirname(fromFile), spec));
  for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const candidate = base + ext;
    if (existsSync(path.join(root, candidate))) return candidate;
  }
  return null;
}

/**
 * Walk RUNTIME imports (type-only imports are erased by TS and cost nothing at
 * runtime) from an entry file, collecting paths that reach `target`.
 */
function runtimeImportPathsTo(entry, target) {
  const importLine = /^\s*import\s+(?:type\s+)?[\s\S]*?from\s+'([^']+)'/;
  const seen = new Set();
  const stack = [[entry, [entry]]];
  const hits = [];
  while (stack.length) {
    const [file, trail] = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let src;
    try {
      src = read(file);
    } catch {
      continue;
    }
    for (const line of src.split('\n')) {
      const m = importLine.exec(line);
      if (!m) continue;
      if (/^\s*import\s+type\s/.test(line)) continue; // erased at compile time
      const spec = m[1];
      if (spec === target) {
        hits.push([...trail, `<${spec}>`]);
        continue;
      }
      const resolved = resolveRelative(spec, file);
      if (resolved && !seen.has(resolved)) stack.push([resolved, [...trail, resolved]]);
    }
  }
  return hits;
}

const RECORD = 'app/(app)/(tabs)/record.tsx';

test('the Record screen never links FFmpeg at module load', () => {
  // src/lib/ffmpeg imports ffmpeg-kit-react-native, whose module load links the
  // FFmpeg native .so set into the process. Mounting the Record tab used to pay
  // that on every visit through TWO static paths — the direct
  // checkAudioSilenceForUpload import and the transitive one via oversizedSplit.
  // Lazying only one of them achieves nothing, which is exactly the mistake this
  // fence catches.
  const hits = runtimeImportPathsTo(RECORD, 'ffmpeg-kit-react-native');
  assert.equal(
    hits.length,
    0,
    `Record screen statically pulls FFmpeg:\n${hits.map((h) => '  ' + h.join(' -> ')).join('\n')}`,
  );
});

test('both FFmpeg users load it lazily, at the call site', () => {
  assert.match(read(RECORD), /require\('\.\.\/\.\.\/\.\.\/src\/lib\/ffmpeg'\)\.checkAudioSilenceForUpload/);
  assert.match(read('src/lib/oversizedSplit.ts'), /require\('\.\/ffmpeg'\)\.splitAudioBySize/);
});

test('android:largeHeap is applied via a registered config plugin', () => {
  // android/ is not committed (EAS managed build), so this can only be a plugin.
  assert.match(read('app.config.ts'), /'\.\/plugins\/with-android-large-heap'/);
  const plugin = read('plugins/with-android-large-heap.js');
  assert.match(plugin, /withAndroidManifest/);
  assert.match(plugin, /application\.\$\['android:largeHeap'\] = 'true'/);
  // Must fail loudly rather than silently no-op if the manifest shape changes.
  assert.match(plugin, /throw new Error\('with-android-large-heap/);
});

test('the heavy mount sweeps are serialized, and the UI-driving scan is not', () => {
  const src = read(RECORD);
  assert.match(src, /let startupSweepTail: Promise<void> = Promise\.resolve\(\)/);
  // Both heavy sweeps opt in (trailing `true` arg).
  assert.match(src, /\}, 3_000, 10_000, true\);/, 'orphan_cleanup must be serialized');
  assert.match(src, /\}, 4_000, 10_000, true\);/, 'thirty_day_eviction must be serialized');
  // record_pending_draft_scan drives visible state and re-fires on draft
  // changes; queueing it behind a multi-second eviction pass would strand
  // "syncing to server…" on screen after the sync had already succeeded.
  const scan = src.slice(src.indexOf("scheduleNonUrgentWork('record_pending_draft_scan'"));
  assert.match(scan.slice(0, 400), /\}, 1_500\);/);
});

test('a failing sweep cannot break the chain for the next one', () => {
  const src = read(RECORD);
  const chain = src.slice(src.indexOf('startupSweepTail = startupSweepTail'));
  assert.match(chain.slice(0, 1500), /\(\) => \{\},\s*\n\s*\(\) => \{\},/);
});

test('a cancelled sweep does not run after waiting in the queue', () => {
  const src = read(RECORD);
  assert.match(src, /cancelled\s*\n?\s*\? undefined/);
});

test('a hung sweep cannot strand the queue forever (rule 24)', () => {
  // These sweeps are SecureStore reads, which hang silently on a degraded
  // Keystore. Without a deadline the module-scoped tail stays pending and every
  // later orphan cleanup and eviction is stranded for the rest of the process —
  // the rejection handler only recovers from a SETTLED rejection.
  const src = read(RECORD);
  const chain = src.slice(src.indexOf('startupSweepTail = startupSweepTail'), src.indexOf('startupSweepTail = startupSweepTail') + 1500);
  assert.match(chain, /withPromiseTimeout\(/);
  assert.match(chain, /STARTUP_SWEEP_TIMEOUT_MS/);
  assert.match(src, /const STARTUP_SWEEP_TIMEOUT_MS = [\d_]+;/);
});

test('the battery-optimization prompt is one-time, Android-only, and marks before showing', () => {
  const src = read('src/lib/batteryOptimization.ts');
  assert.match(src, /export async function maybePromptBatteryOptimization/);
  assert.match(src, /if \(Platform\.OS !== 'android'\) return;/);
  // Marking after the Alert would re-prompt forever if the user backgrounds the
  // app on the dialog; a failed write must skip the prompt, not repeat it.
  const markIdx = src.indexOf('setRawItem(PROMPTED_KEY');
  const alertIdx = src.indexOf('Alert.alert(');
  assert.ok(markIdx > 0 && alertIdx > markIdx, 'must persist the marker before showing the Alert');
  assert.match(src, /if \(!marked\) return;/);
  // Rule 2: Alert callbacks are () => void — never hand them a promise.
  assert.doesNotMatch(src, /onPress: async \(\)/);
});

test('the battery prompt is actually wired into the Record screen', () => {
  // openBatteryOptimizationSettings previously shipped with ZERO callers.
  const src = read(RECORD);
  // User-scoped read-back: a process-wide answer would tell vet B about vet A's
  // kill on a shared tablet.
  assert.match(src, /maybePromptBatteryOptimization\(priorProcessKillDetected\(user\?\.id\)\)/);
});

test('battery-prompt copy lives in the strings catalog', () => {
  const strings = read('src/constants/strings.ts');
  assert.match(strings, /export const BATTERY_OPTIMIZATION_COPY/);
  assert.match(strings, /bodyAfterKill:/);
  assert.doesNotMatch(read('src/lib/batteryOptimization.ts'), /Alert\.alert\(\s*'/);
});
