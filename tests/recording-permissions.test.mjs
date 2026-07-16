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

test('recording role gate allows only roles that can submit recordings', async () => {
  const {
    canRecordAppointments,
    RECORD_APPOINTMENT_PERMISSION_MESSAGE,
  } = await loadTsModule('src/lib/recordingPermissions.ts');

  assert.equal(canRecordAppointments('owner'), true);
  assert.equal(canRecordAppointments('admin'), true);
  assert.equal(canRecordAppointments('veterinarian'), true);
  assert.equal(canRecordAppointments('support_staff'), false);
  assert.equal(canRecordAppointments('receptionist'), false);
  assert.equal(canRecordAppointments(null), false);
  assert.equal(canRecordAppointments(undefined), false);

  assert.match(RECORD_APPOINTMENT_PERMISSION_MESSAGE, /do not sign out/i);
  assert.match(RECORD_APPOINTMENT_PERMISSION_MESSAGE, /same account temporarily promoted/i);
});

test('support staff recording gate covers entrypoints and submit paths', async () => {
  const tabsLayout = await read('app/(app)/(tabs)/_layout.tsx');
  const home = await read('app/(app)/(tabs)/index.tsx');
  const recordings = await read('app/(app)/(tabs)/recordings/index.tsx');
  const record = await read('app/(app)/(tabs)/record.tsx');

  assert.match(tabsLayout, /event\.preventDefault\(\);\s*showRecordPermissionAlert\(\);/);
  assert.match(home, /if \(!canRecordAppointments\(user\?\.role\)\) \{/);
  assert.match(recordings, /if \(!canRecordAppointments\(user\?\.role\)\) \{/);
  assert.match(record, /const roleBlocked = !!user && !canRecordAppointments\(user\.role\);/);
  assert.match(record, /if \(roleBlocked\) \{\s*return <RecordingRoleGate \/>;\s*\}/);
  assert.match(record, /if \(!canRecordAppointments\(user\?\.role\)\) \{\s*showRecordPermissionAlert\(\);\s*return null;\s*\}/);
  assert.match(record, /const handleSubmitSingle = useCallback\([\s\S]*?if \(!canRecordAppointments\(user\?\.role\)\)/);
  assert.match(record, /const handleSubmitAll = useCallback\(\(\) => \{\s*if \(!canRecordAppointments\(user\?\.role\)\)/);
  assert.match(record, /if \(roleBlocked\) \{\s*return <RecordingRoleGate \/>;\s*\}[\s\S]*return <RecordingSession \/>;/);
  assert.match(record, /useEffect\(\(\) => \{\s*if \(!user\?\.id\) return;[\s\S]*scheduleNonUrgentWork\('record_pending_draft_scan'/);
});

test('API client maps known recording API error codes to safe messages', async () => {
  const client = await read('src/api/client.ts');

  assert.match(client, /errorBody\.code === 'MFA_REQUIRED'/);
  assert.match(client, /errorBody\.code === 'ROLE_FORBIDDEN'/);
  assert.match(client, /Your role cannot create, upload, or delete recordings\./);
  assert.match(client, /errorBody\.code === 'CREDENTIALS_REQUIRED'/);
  assert.match(client, /Service credentials are required to submit recordings\./);
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

test('metadata review/add/edit cards are gated on edit permission (no 403 "Save Failed")', async () => {
  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');
  // All three metadata-edit affordances require recordingPermissions.canEdit,
  // mirroring the server PATCH /:id/metadata author/owner/admin guard so a vet
  // never sees Edit/Review/Add on a colleague's recording then hits a 403.
  assert.match(detail, /const showMetadataReview =\s*recordingPermissions\.canEdit/);
  assert.match(detail, /const showAddMetadata =\s*recordingPermissions\.canEdit/);
  assert.match(detail, /const showEditMetadata =\s*recordingPermissions\.canEdit/);
});

test('ApiClient routes an unrecoverable 401 to sign-out instead of a zombie session', async () => {
  const client = await read('src/api/client.ts');
  assert.match(client, /private onSessionExpired\?/);
  assert.match(client, /setOnSessionExpired\(callback/);
  // After onUnauthorized()'s refresh+retry, a still-401 response fires onSessionExpired.
  assert.match(
    client,
    /if \(response\.status === 401\) \{\s*throwIfRequestAborted\(signal\);\s*try \{ await this\.onSessionExpired\?\.\(\);/
  );

  const auth = await read('src/auth/AuthProvider.tsx');
  // Wired with fresh-session + in-progress-sign-out guards, then signs out to re-auth.
  assert.match(auth, /apiClient\.setOnSessionExpired\(async \(\) => \{/);
  assert.match(
    auth,
    /setOnSessionExpired[\s\S]*sessionAge < 10_000[\s\S]*userInitiatedSignOutRef\.current[\s\S]*setLogoutReason\('session_expired'\)[\s\S]*handleSignOut/
  );
});
