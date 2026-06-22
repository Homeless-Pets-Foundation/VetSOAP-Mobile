import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import ts from 'typescript';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const requireForVm = createRequire(import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

// Module runs in a fresh vm realm, so values it returns have a different
// Array/Object prototype than this file's. Compare via primitives / lengths,
// never assert.deepEqual on the returned structures.
async function loadTsModule(path) {
  const source = await read(path);
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
  }).outputText;

  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require: requireForVm,
  });
  return module.exports;
}

const task = (id, type, status = 'suggested') => ({
  id,
  type,
  title: `task ${id}`,
  detail: null,
  status,
});

test('groupRecordingTasks puts billing first and drops empty groups', async () => {
  const { groupRecordingTasks } = await loadTsModule('src/lib/recordingTasks.ts');

  // todo listed before billing in the input — output must still be billing first.
  const groups = groupRecordingTasks([
    task('a', 'todo'),
    task('b', 'billing'),
    task('c', 'todo'),
  ]);

  assert.equal(groups.length, 2);
  assert.equal(groups[0].type, 'billing');
  assert.equal(groups[0].tasks.length, 1);
  assert.equal(groups[1].type, 'todo');
  assert.equal(groups[1].tasks.length, 2);
});

test('groupRecordingTasks drops a group with no items', async () => {
  const { groupRecordingTasks } = await loadTsModule('src/lib/recordingTasks.ts');

  const onlyBilling = groupRecordingTasks([task('a', 'billing'), task('b', 'billing')]);
  assert.equal(onlyBilling.length, 1);
  assert.equal(onlyBilling[0].type, 'billing');

  assert.equal(groupRecordingTasks([]).length, 0);
});

test('groupRecordingTasks retains tasks of every status (resolved not filtered)', async () => {
  const { groupRecordingTasks } = await loadTsModule('src/lib/recordingTasks.ts');

  const groups = groupRecordingTasks([
    task('a', 'todo', 'suggested'),
    task('b', 'todo', 'accepted'),
    task('c', 'todo', 'dismissed'),
    task('d', 'todo', 'done'),
  ]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].tasks.length, 4);
});

test('unwrapTaskList guards against null, missing, and non-array data', async () => {
  const { unwrapTaskList } = await loadTsModule('src/lib/recordingTasks.ts');

  const UUID_A = '11111111-1111-4111-8111-111111111111';
  const unwrapped = unwrapTaskList({ data: [task(UUID_A, 'billing')] });
  assert.equal(unwrapped.length, 1);
  assert.equal(unwrapped[0].id, UUID_A);

  assert.equal(unwrapTaskList({ data: [] }).length, 0);
  assert.equal(unwrapTaskList(null).length, 0);
  assert.equal(unwrapTaskList(undefined).length, 0);
  assert.equal(unwrapTaskList({}).length, 0);
  assert.equal(unwrapTaskList({ data: null }).length, 0);
  assert.equal(unwrapTaskList({ data: 'nope' }).length, 0);
});

test('unwrapTaskList drops malformed items, rejects non-UUID ids, normalizes detail', async () => {
  const { unwrapTaskList } = await loadTsModule('src/lib/recordingTasks.ts');

  const UUID_A = '11111111-1111-4111-8111-111111111111';
  const UUID_B = '22222222-2222-4222-8222-222222222222';
  const UUID_C = '33333333-3333-4333-8333-333333333333';

  const out = unwrapTaskList({
    data: [
      task(UUID_A, 'billing'),
      null, // not an object
      { id: UUID_B, type: 'billing', title: 't', status: 'suggested' }, // detail missing -> null
      { id: UUID_C, type: 'bogus', title: 't', detail: null, status: 'suggested' }, // bad type
      { id: UUID_C, type: 'todo', title: 't', detail: null, status: 'invented' }, // bad status
      { type: 'todo', title: 't', detail: null, status: 'suggested' }, // missing id
      { id: UUID_C, type: 'todo', title: 42, detail: null, status: 'suggested' }, // non-string title
      { id: 'not-a-uuid', type: 'todo', title: 't', detail: null, status: 'suggested' }, // bad id
      { id: '..', type: 'todo', title: 't', detail: null, status: 'suggested' }, // path-traversal id
    ],
  });

  // Only UUID_A and UUID_B are well-formed.
  assert.equal(out.length, 2);
  assert.equal(out[0].id, UUID_A);
  assert.equal(out[1].id, UUID_B);
  assert.equal(out[1].detail, null); // missing detail normalized to null
});

test('getTasksRefetchInterval polls only while empty + recently completed + active', async () => {
  const { getTasksRefetchInterval } = await loadTsModule('src/lib/recordingTasks.ts');
  const now = 1_000_000_000_000;

  // Have tasks -> stop polling.
  assert.equal(
    getTasksRefetchInterval({ tasksCount: 3, appActive: true, completedAtMs: now, nowMs: now, attempts: 0 }),
    false
  );

  // Backgrounded -> stop polling (even if empty + recent).
  assert.equal(
    getTasksRefetchInterval({ tasksCount: 0, appActive: false, completedAtMs: now, nowMs: now, attempts: 0 }),
    false
  );

  // Empty + just completed + active -> poll at the base interval.
  assert.equal(
    getTasksRefetchInterval({ tasksCount: 0, appActive: true, completedAtMs: now, nowMs: now, attempts: 0 }),
    5_000
  );

  // Backoff grows with attempts and caps at 30s.
  assert.equal(
    getTasksRefetchInterval({ tasksCount: 0, appActive: true, completedAtMs: now, nowMs: now, attempts: 1 }),
    7_500
  );
  assert.equal(
    getTasksRefetchInterval({ tasksCount: 0, appActive: true, completedAtMs: now, nowMs: now, attempts: 20 }),
    30_000
  );

  // Empty but completed long ago (> 10 min) -> genuinely empty, stop polling.
  assert.equal(
    getTasksRefetchInterval({
      tasksCount: 0,
      appActive: true,
      completedAtMs: now - 11 * 60 * 1000,
      nowMs: now,
      attempts: 0,
    }),
    false
  );

  // Unknown completion time + empty + active -> still polls (best effort).
  assert.equal(
    getTasksRefetchInterval({ tasksCount: 0, appActive: true, completedAtMs: null, nowMs: now, attempts: 0 }),
    5_000
  );
});
