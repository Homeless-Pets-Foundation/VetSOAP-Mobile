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

  const unwrapped = unwrapTaskList({ data: [task('a', 'billing')] });
  assert.equal(unwrapped.length, 1);
  assert.equal(unwrapped[0].id, 'a');

  assert.equal(unwrapTaskList({ data: [] }).length, 0);
  assert.equal(unwrapTaskList(null).length, 0);
  assert.equal(unwrapTaskList(undefined).length, 0);
  assert.equal(unwrapTaskList({}).length, 0);
  assert.equal(unwrapTaskList({ data: null }).length, 0);
  assert.equal(unwrapTaskList({ data: 'nope' }).length, 0);
});

test('unwrapTaskList drops malformed items and normalizes detail', async () => {
  const { unwrapTaskList } = await loadTsModule('src/lib/recordingTasks.ts');

  const good = task('a', 'billing');
  const out = unwrapTaskList({
    data: [
      good,
      null, // not an object
      { id: 'b', type: 'billing', title: 't', status: 'suggested' }, // detail missing -> null
      { id: 'c', type: 'bogus', title: 't', detail: null, status: 'suggested' }, // bad type
      { id: 'd', type: 'todo', title: 't', detail: null, status: 'invented' }, // bad status
      { type: 'todo', title: 't', detail: null, status: 'suggested' }, // missing id
      { id: 'e', type: 'todo', title: 42, detail: null, status: 'suggested' }, // non-string title
    ],
  });

  // Only 'a' and 'b' are well-formed.
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'a');
  assert.equal(out[1].id, 'b');
  assert.equal(out[1].detail, null); // missing detail normalized to null
});
