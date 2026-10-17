/**
 * The durable recorder runs on its own serial queue, not Expo's shared one.
 *
 * Expo runs every module's AsyncFunctions on one shared queue
 * (`expo.modules.AsyncFunctionQueue`). A durable stop joins three pipeline
 * threads and fsyncs inline, so on the clinic tablets SecureStore, file-system
 * and expo-audio calls queued behind 1-2 s starts and stops of up to 15 s.
 *
 * These guards fence the parts of the fix that a refactor could silently undo:
 * every recorder call moved, the queue stays serial and is never cancelled, and
 * the expo fallback waits for a late native start to release the mic.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const ANDROID_MODULE =
  'modules/captivet-durable-recorder/android/src/main/java/expo/modules/captivetdurablerecorder/CaptivetDurableRecorderModule.kt';
const IOS_MODULE = 'modules/captivet-durable-recorder/ios/CaptivetDurableRecorderModule.swift';
const IOS_ENGINE = 'modules/captivet-durable-recorder/ios/DurableRecorderEngine.swift';
const HOOK = 'src/hooks/useAudioRecorder.ts';
const RECORD = 'app/(app)/(tabs)/record.tsx';

const count = (src, re) => (src.match(re) ?? []).length;

/** A top-level DSL block from its header through the end of its closing-brace line. */
function block(src, header) {
  const start = src.indexOf(header);
  assert.ok(start >= 0, `missing ${header}`);
  const close = src.indexOf('\n    }', start) + 1;
  return src.slice(start, src.indexOf('\n', close));
}

function constant(src, name) {
  const match = src.match(new RegExp(`const ${name} = ([0-9_]+);`));
  assert.ok(match, `missing ${name}`);
  return Number(match[1].replaceAll('_', ''));
}

test('every Android recorder AsyncFunction runs on the dedicated queue', () => {
  const src = read(ANDROID_MODULE);
  const asyncFunctions = count(src, /^ {4}AsyncFunction\("/gm);
  assert.equal(asyncFunctions, 13);
  assert.equal(count(src, /^ {4}\}\.runOnQueue\(DurableRecorderQueue\.scope\)$/gm), asyncFunctions);
  // The 500 ms live-stats poll stays a synchronous Function on the JS thread.
  assert.match(src, /Function\("getLiveStats"\) \{\s*DurableRecorderEngine\.getLiveStats\(\)\s*\}\n/);
  assert.doesNotMatch(block(src, 'Function("getLiveStats")'), /runOnQueue/);
});

test('the Android queue is one serial, process-wide, never-cancelled thread', () => {
  const src = read(ANDROID_MODULE);
  assert.match(src, /^internal object DurableRecorderQueue \{/m);
  // Serial: unlocked manifest read-modify-writes rely on one call at a time.
  assert.equal(count(src, /newSingleThreadExecutor/g), 1);
  assert.match(src, /Thread\(runnable, "captivet\.durable-recorder"\)/);
  assert.doesNotMatch(src, /Dispatchers\.(IO|Default)|newFixedThreadPool|newCachedThreadPool/);
  // Never cancelled: a cancelled scope drops later launches, so promises from
  // a module recreated after a JS reload would never settle.
  assert.doesNotMatch(src, /\.cancel\(|\.close\(\)|shutdown\(/);
  const onDestroy = block(src, 'OnDestroy {');
  assert.match(onDestroy, /DurableRecorderEngine\.detach\(\)/);
});

test('every iOS recorder AsyncFunction runs on a dedicated serial queue', () => {
  const src = read(IOS_MODULE);
  const asyncFunctions = count(src, /^ {4}AsyncFunction\("/gm);
  assert.equal(asyncFunctions, 13);
  assert.equal(count(src, /^ {4}\}\.runOnQueue\(durableRecorderQueue\)$/gm), asyncFunctions);
  assert.doesNotMatch(block(src, 'Function("getLiveStats")'), /runOnQueue/);

  const queue = src.match(/private let durableRecorderQueue = DispatchQueue\(([\s\S]*?)\)\n/);
  assert.ok(queue, 'file-scope queue');
  assert.match(queue[1], /label: "com\.captivet\.durable-recorder"/);
  assert.doesNotMatch(queue[1], /concurrent/);
  // Control ops `sync` onto the engine's writer queue; running them ON that
  // queue would deadlock.
  const writer = read(IOS_ENGINE).match(/writerQueue = DispatchQueue\(label: "([^"]+)"/);
  assert.ok(writer);
  assert.notEqual(writer[1], 'com.captivet.durable-recorder');
});

test('the expo fallback waits, bounded, for a late durable start to release the mic', () => {
  const hook = read(HOOK);
  const fallback = hook.indexOf('// fall through to expo-audio path below');
  const wait = hook.indexOf('await settleWithin(lateStartReleased, DURABLE_LATE_START_SETTLE_MS)');
  assert.ok(wait > 0 && wait < fallback, 'the wait precedes the fallback');
  assert.match(
    hook.slice(hook.lastIndexOf('} catch (durableError) {', wait), wait),
    /if \(durableStartTimedOut\) \{/,
    'only a timed-out start is waited on',
  );
  // The settled promise covers the discard, not just the start.
  assert.match(
    hook,
    /lateStartReleased = startPromise\.then\(\s*async \(\) => \{\s*if \(durableStartTimedOut\) \{\s*await durableRecorder\s*\.discard\(/,
  );
});

test('the start watchdog leaves the hook room to unwind first', () => {
  const hook = read(HOOK);
  const record = read(RECORD);
  const hookBudget =
    constant(hook, 'DURABLE_START_TIMEOUT_MS') + constant(hook, 'DURABLE_LATE_START_SETTLE_MS');
  const watchdog = constant(record, 'DURABLE_START_WATCHDOG_MS');
  // At least 5 s for the expo-audio fallback (prepare + record) on a slow tablet.
  assert.ok(hookBudget + 5_000 <= watchdog, `${hookBudget} + 5000 <= ${watchdog}`);
  assert.match(record, /op === 'start' \? DURABLE_START_WATCHDOG_MS : DURABLE_OP_WATCHDOG_MS/);
  // The other ops keep their bound.
  assert.equal(constant(record, 'DURABLE_OP_WATCHDOG_MS'), 12000);
});

test('settleWithin resolves on settle or deadline and never rejects', async () => {
  const hook = read(HOOK);
  const start = hook.indexOf('function settleWithin(');
  const end = hook.indexOf('\n}\n', start) + 2;
  const { outputText } = ts.transpileModule(hook.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  });
  const settleWithin = new Function(`${outputText}\nreturn settleWithin;`)();

  const rejected = Promise.reject(new Error('late start failed'));
  await settleWithin(rejected, 1_000);

  let t0 = Date.now();
  await settleWithin(new Promise(() => {}), 50);
  assert.ok(Date.now() - t0 >= 45, 'waits for the deadline when the op never settles');

  t0 = Date.now();
  await settleWithin(Promise.resolve('ok'), 5_000);
  assert.ok(Date.now() - t0 < 1_000, 'returns as soon as the op settles');
});
