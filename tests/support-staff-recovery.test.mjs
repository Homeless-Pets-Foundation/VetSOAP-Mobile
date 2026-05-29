import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

async function loadRecoveryVaultForTest() {
  const source = await read('src/lib/supportStaffRecoveryVault.ts');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
  }).outputText;

  const secureStore = new Map();
  const files = new Set();
  const copyFailures = new Set();
  const drafts = { current: [] };
  const stashes = { current: [] };
  const messages = [];

  class MockFile {
    constructor(uri) {
      this.uri = uri;
      this.name = uri.split('/').filter(Boolean).at(-1) ?? '';
    }

    copy(target) {
      if (!files.has(this.uri)) {
        throw new Error('missing source');
      }
      files.add(target.uri);
    }

    write(value) {
      files.add(this.uri);
      this.value = value;
    }

    async text() {
      return this.value ?? '';
    }
  }

  class MockDirectory {
    constructor(uri) {
      this.uri = uri;
      this.name = uri.split('/').filter(Boolean).at(-1) ?? '';
    }

    list() {
      return [];
    }
  }

  const mocks = {
    'expo-secure-store': {
      AFTER_FIRST_UNLOCK: 'after-first-unlock',
      getItemAsync: async (key) => secureStore.get(key) ?? null,
      setItemAsync: async (key, value) => {
        secureStore.set(key, value);
      },
      deleteItemAsync: async (key) => {
        secureStore.delete(key);
      },
    },
    'expo-file-system': {
      Directory: MockDirectory,
      File: MockFile,
      Paths: { document: { uri: 'file:///doc/' } },
    },
    'expo-file-system/legacy': {
      copyAsync: async ({ from, to }) => {
        if (!files.has(from)) throw new Error('missing source');
        files.add(to);
      },
    },
    './draftStorage': {
      draftStorage: {
        listDrafts: async () => drafts.current,
        saveDraft: async (slot) => ({ draftSlotId: slot.id, promotedSegments: slot.segments }),
        deleteDraft: async () => {},
      },
    },
    './stashStorage': {
      stashStorage: {
        getStashedSessions: async () => stashes.current,
      },
    },
    './fileOps': {
      directoryExists: () => false,
      ensureDirectory: () => true,
      fileExists: (uri) => files.has(uri),
      safeCopyFile: async (from, to) => {
        if (!files.has(from) || copyFailures.has(from)) return false;
        files.delete(to);
        files.add(to);
        return true;
      },
      safeDeleteDirectory: (dir) => {
        for (const file of [...files]) {
          if (file.startsWith(dir)) files.delete(file);
        }
      },
      safeDeleteFile: (uri) => {
        files.delete(uri);
      },
    },
    './secureStorage': {
      secureStorage: {
        getRawItem: async (key) => secureStore.get(key) ?? null,
        setRawItem: async (key, value) => {
          secureStore.set(key, value);
          return true;
        },
        deleteRawItem: async (key) => {
          secureStore.delete(key);
        },
      },
    },
    './monitoring': {
      captureMessage: (message, level, context) => {
        messages.push({ message, level, context });
      },
    },
  };

  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require: (id) => {
      if (mocks[id]) return mocks[id];
      throw new Error(`Unexpected require: ${id}`);
    },
  });

  return {
    ...module.exports,
    drafts,
    stashes,
    files,
    copyFailures,
    messages,
  };
}

function makeDraft(slotId) {
  const uri = `file:///source/${slotId}.m4a`;
  return {
    slotId,
    savedAt: '2026-05-27T00:00:00.000Z',
    formData: {
      patientName: `Patient ${slotId}`,
      clientName: 'Client',
      species: 'Canine',
      breed: '',
      appointmentType: 'Wellness',
    },
    segments: [{ uri, duration: 10 }],
    audioDuration: 10,
    serverDraftId: null,
    pendingSync: false,
  };
}

test('auth supports required recovery preservation before destructive sign-out cleanup', async () => {
  const auth = await read('src/auth/AuthProvider.tsx');

  assert.match(auth, /export type SignOutRecoveryMode = 'required' \| 'best_effort' \| 'destructive'/);
  assert.match(auth, /signOut: \(options\?: SignOutOptions\) => Promise<void>/);
  assert.match(auth, /mode === 'destructive'/);
  assert.match(auth, /SUPPORT_STAFF_RECOVERY_REQUIRED_TIMEOUT_MS = 60_000/);
  assert.match(auth, /SUPPORT_STAFF_RECOVERY_BEST_EFFORT_TIMEOUT_MS = 5_000/);
  assert.match(auth, /throw new Error\(SUPPORT_STAFF_RECOVERY_PRESERVE_FAILED\)/);
  assert.match(
    auth,
    /const recoveryMode = options\.recoveryMode \?\? 'best_effort';\s*await preserveSupportStaffRecordings\(activeUserRef\.current, recoveryMode\);\s*userInitiatedSignOutRef\.current = true;/
  );
  assert.match(
    auth,
    /await preserveSupportStaffRecordings\(activeUserRef\.current, recoveryMode\);[\s\S]*?await withTimeout\(clearTransientCaches\(\), 3000, 'transient_caches_cleanup'\);/
  );
  assert.match(auth, /preserveSupportStaffRecordings\(activeUserRef\.current, 'best_effort'\)/);
});

test('support staff recovery vault filters by organization and avoids global scope mutation while scanning', async () => {
  const vault = await read('src/lib/supportStaffRecoveryVault.ts');
  const drafts = await read('src/lib/draftStorage.ts');
  const stashes = await read('src/lib/stashStorage.ts');

  assert.match(vault, /support-staff-recovery\//);
  assert.match(vault, /captivet_support_staff_recovery_active/);
  assert.match(vault, /async listItemsForUser\(user: RecoveryUser/);
  assert.match(vault, /async countItemsForUser\(user: RecoveryUser/);
  assert.match(vault, /async scanForLeftoverRecordingsForUser\(user: RecoveryUser/);
  assert.match(vault, /item\.sourceOrganizationId === user\.organizationId/);
  assert.match(vault, /RECOVERY_ROLES = new Set\(\['owner', 'admin', 'veterinarian'\]\)/);
  assert.match(vault, /secureStorage\.getRawItem/);
  assert.match(vault, /secureStorage\.setRawItem/);
  assert.match(vault, /secureStorage\.deleteRawItem/);
  assert.match(vault, /safeCopyFile\(sourceUri, destUri\)/);
  assert.match(vault, /support_staff_recovery_copy_incomplete/);
  assert.doesNotMatch(vault, /expo-file-system\/legacy/);
  assert.doesNotMatch(vault, /SecureStore\./);
  assert.doesNotMatch(vault, /legacyCopyAsync/);
  assert.match(vault, /Older draft\/stash directories do not carry organization metadata/);
  assert.match(vault, /await readValidItemsAndPrune\(\)/);
  assert.doesNotMatch(vault, /scanDraftDirectoryForUser/);
  assert.doesNotMatch(vault, /scanStashDirectoryForUser/);
  assert.doesNotMatch(vault, /draftStorage\.listDraftsForUser\(sourceUserId\)/);
  assert.doesNotMatch(vault, /stashStorage\.getStashedSessionsForUser\(sourceUserId\)/);
  assert.doesNotMatch(vault, /readRecoveryManifest\(sessionId, sourceUserId\)/);
  assert.doesNotMatch(vault, /draftStorage\.setUserId\(sourceUserId\)/);
  assert.doesNotMatch(vault, /stashStorage\.setUserId\(sourceUserId\)/);
  assert.doesNotMatch(vault, /stashAudioManager\.setUserId\(sourceUserId\)/);
  assert.match(drafts, /async listDraftsForUser\(userId: string\): Promise<DraftMetadata\[\]>/);
  assert.match(stashes, /async getStashedSessionsForUser\(userId: string\): Promise<StashedSession\[\]>/);
});

test('preservation returns structured results and dedupes only against valid recovery copies', async () => {
  const vault = await read('src/lib/supportStaffRecoveryVault.ts');

  assert.match(vault, /export interface RecoveryPreserveResult/);
  assert.match(vault, /ok: boolean/);
  assert.match(vault, /recoverableCount: number/);
  assert.match(vault, /preservedCount: number/);
  assert.match(vault, /failedCount: number/);
  assert.match(vault, /errorCode: RecoveryPreserveErrorCode/);
  assert.match(vault, /capacity_exceeded/);
  assert.match(vault, /async function readValidItemsAndPrune\(\)/);
  assert.match(vault, /let expectedSegments = 0/);
  assert.match(vault, /copiedSegments < expectedSegments/);
  assert.match(vault, /const validItems = items\.filter\(itemHasAudio\)/);
  assert.match(vault, /const existing = await readValidItemsAndPrune\(\)/);
  assert.match(vault, /existing\.length \+ deduped\.length > MAX_RECOVERY_ITEMS/);
  assert.match(vault, /const duplicateItems = itemsToAdd\.filter/);
  assert.match(vault, /duplicateItems\.forEach\(\(item\) => safeDeleteDirectory\(recoveryDir\(item\.id\)\)\)/);
  assert.match(vault, /addResult\.ok && failedCount === 0/);
});

test('recovery vault blocks preservation when capacity would drop new recordings', async () => {
  const { supportStaffRecoveryVault, drafts, files } = await loadRecoveryVaultForTest();
  const sourceUser = {
    id: 'support-user',
    email: 'csr@example.com',
    fullName: 'Support User',
    role: 'support_staff',
    organizationId: 'org-1',
  };
  const privilegedUser = {
    id: 'admin-user',
    role: 'admin',
    organizationId: 'org-1',
  };

  drafts.current = Array.from({ length: 49 }, (_, index) => makeDraft(`existing-${index}`));
  drafts.current.forEach((draft) => files.add(draft.segments[0].uri));

  const first = await supportStaffRecoveryVault.preserveScopedUserRecordings(sourceUser);
  assert.equal(first.ok, true);
  assert.equal(first.recoverableCount, 49);
  assert.equal(first.preservedCount, 49);
  assert.equal(await supportStaffRecoveryVault.countItemsForUser(privilegedUser), 49);

  drafts.current = [makeDraft('new-1'), makeDraft('new-2')];
  drafts.current.forEach((draft) => files.add(draft.segments[0].uri));

  const second = await supportStaffRecoveryVault.preserveScopedUserRecordings(sourceUser);
  assert.equal(second.ok, false);
  assert.equal(second.errorCode, 'capacity_exceeded');
  assert.equal(second.recoverableCount, 2);
  assert.equal(second.preservedCount, 0);
  assert.equal(second.failedCount, 2);
  assert.equal(await supportStaffRecoveryVault.countItemsForUser(privilegedUser), 49);
});

test('recovery vault reports copy failures and keeps delete scoped to the current organization', async () => {
  const { supportStaffRecoveryVault, drafts, files, copyFailures, messages } = await loadRecoveryVaultForTest();
  const sourceUser = {
    id: 'support-user',
    email: 'csr@example.com',
    fullName: 'Support User',
    role: 'support_staff',
    organizationId: 'org-1',
  };
  const sameOrgUser = {
    id: 'admin-user',
    role: 'admin',
    organizationId: 'org-1',
  };
  const otherOrgUser = {
    id: 'other-admin',
    role: 'admin',
    organizationId: 'org-2',
  };

  const failedDraft = makeDraft('failed-copy');
  drafts.current = [failedDraft];
  files.add(failedDraft.segments[0].uri);
  copyFailures.add(failedDraft.segments[0].uri);

  const failed = await supportStaffRecoveryVault.preserveScopedUserRecordings(sourceUser);
  assert.equal(failed.ok, false);
  assert.equal(failed.errorCode, 'copy_failed');
  assert.equal(messages.some((entry) => entry.message === 'support_staff_recovery_copy_incomplete'), true);
  assert.equal(await supportStaffRecoveryVault.countItemsForUser(sameOrgUser), 0);

  copyFailures.clear();
  drafts.current = [makeDraft('saved-copy')];
  files.add(drafts.current[0].segments[0].uri);

  const saved = await supportStaffRecoveryVault.preserveScopedUserRecordings(sourceUser);
  assert.equal(saved.ok, true);
  const items = await supportStaffRecoveryVault.listItemsForUser(sameOrgUser);
  assert.equal(items.length, 1);

  assert.equal(await supportStaffRecoveryVault.deleteItem(otherOrgUser, items[0].id), false);
  assert.equal(await supportStaffRecoveryVault.countItemsForUser(sameOrgUser), 1);
  assert.equal(await supportStaffRecoveryVault.deleteItem(sameOrgUser, items[0].id), true);
  assert.equal(await supportStaffRecoveryVault.countItemsForUser(sameOrgUser), 0);
});

test('restore is same-org, all-or-nothing, strips server draft state, and consumes recovery copy', async () => {
  const vault = await read('src/lib/supportStaffRecoveryVault.ts');

  assert.match(vault, /restoreItemToCurrentUserDrafts\(\s*user: RecoveryUser/);
  assert.match(vault, /!item \|\| !itemVisibleToUser\(item, user\)/);
  assert.match(vault, /if \(slotsToRestore\.some\(\(entry\) => entry === null\)\) return \[\]/);
  assert.match(vault, /Promise\.all\(restoredSlotIds\.map\(\(slotId\) => draftStorage\.deleteDraft\(slotId\)\.catch\(\(\) => \{\}\)\)\)/);
  assert.match(vault, /await this\.deleteItem\(user, item\.id\)/);
  assert.match(vault, /deleteItem\(user: RecoveryUser \| null \| undefined, itemId: string\): Promise<boolean>/);
  assert.match(vault, /if \(!item \|\| !itemVisibleToUser\(item, user\)\) return false/);
  assert.match(vault, /serverRecordingId: null/);
  assert.match(vault, /serverDraftId: null/);
  assert.match(vault, /pendingConfirm: null/);
});

test('settings and recovery screens use scoped recovery APIs and expose destructive fallback only on preserve failure', async () => {
  const settings = await read('app/(app)/(tabs)/settings.tsx');
  const recovery = await read('app/(app)/recording-recovery.tsx');

  assert.match(settings, /Recover Local Recordings/);
  assert.match(settings, /router\.push\('\/recording-recovery'/);
  assert.match(settings, /countItemsForUser\(user\)/);
  assert.match(settings, /countScopedUserRecoverableRecordings/);
  assert.match(settings, /Save & Sign Out/);
  assert.match(settings, /signOut\(\{ recoveryMode \}\)/);
  assert.doesNotMatch(settings, /biometrics\.clear/);
  assert.match(settings, /Recovery Save Failed/);
  assert.match(settings, /Sign Out & Delete/);
  assert.match(settings, /runSignOut\('destructive'\)/);
  assert.match(settings, /SUPPORT_STAFF_RECOVERY_PRESERVE_FAILED/);
  assert.match(recovery, /canRecordAppointments\(user\?\.role\)/);
  assert.match(recovery, /scanForLeftoverRecordingsForUser\(user\)/);
  assert.match(recovery, /listItemsForUser\(user\)/);
  assert.match(recovery, /RECOVERY_LOAD_TIMEOUT_MS = 12_000/);
  assert.match(recovery, /loadIdRef/);
  assert.match(recovery, /recording_recovery_watchdog_fired/);
  assert.match(recovery, /scanTimedOut/);
  assert.match(recovery, /Only recovery copies saved during support staff sign-out can be restored automatically/);
  assert.match(recovery, /restoreItemToCurrentUserDrafts\(user, item\.id, overrides\)/);
  assert.match(recovery, /deleteItem\(user, item\.id\)/);
  assert.match(recovery, /Patient Details Required/);
  assert.match(recovery, /router\.replace\(\{\s*pathname: '\/\(tabs\)\/record'/);
  assert.doesNotMatch(recovery, /listItems\(\)/);
  assert.doesNotMatch(recovery, /scanForLeftoverRecordings\(user/);
});
