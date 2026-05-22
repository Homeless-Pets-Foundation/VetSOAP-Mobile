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

const recording = (userId = 'user_vet') => ({ userId });

test('recording permission matrix mirrors server delete authorization', async () => {
  const { getRecordingPermissions } = await loadTsModule('src/lib/recordingPermissions.ts');

  assert.equal(getRecordingPermissions({ id: 'user_owner', role: 'owner' }, recording('user_vet')).canDelete, true);
  assert.equal(getRecordingPermissions({ id: 'user_admin', role: 'admin' }, recording('user_vet')).canDelete, true);
  assert.equal(getRecordingPermissions({ id: 'user_vet', role: 'veterinarian' }, recording('user_vet')).canDelete, true);

  const nonOwnerVet = getRecordingPermissions(
    { id: 'user_vet', role: 'veterinarian' },
    recording('user_other')
  );
  assert.equal(nonOwnerVet.canDelete, false);
  assert.match(nonOwnerVet.deleteBlockedReason, /recording owner or an administrator/);

  const supportStaff = getRecordingPermissions(
    { id: 'user_staff', role: 'support_staff' },
    recording('user_staff')
  );
  assert.equal(supportStaff.canDelete, false);
  assert.equal(supportStaff.deleteBlockedReason, 'Your role cannot delete recordings.');
});

test('API client maps known 403 recording permission codes to safe messages', async () => {
  const client = await read('src/api/client.ts');

  assert.match(client, /errorBody\.code === 'MFA_REQUIRED'/);
  assert.match(client, /errorBody\.code === 'ROLE_FORBIDDEN'/);
  assert.match(client, /Your role cannot create, upload, or delete recordings\./);
  assert.match(client, /errorBody\.code === 'RECORDING_DELETE_FORBIDDEN'/);
  assert.match(client, /Only the recording owner or an administrator can delete this recording\./);
});

test('draft detail screen gates delete and reports delete_draft telemetry', async () => {
  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');

  assert.match(detail, /useRecordingPermissions\(recording\)/);
  assert.match(detail, /recordingPermissions\.canDelete/);
  assert.match(detail, /reportClientError\(\{/);
  assert.match(detail, /phase: 'delete_draft'/);
  assert.match(detail, /errorCode: error instanceof ApiError/);
});
