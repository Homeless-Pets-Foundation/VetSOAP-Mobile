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

// In-memory secureStorage stub so userProfileCache.ts loads without the
// expo-secure-store native module.
const storeBacking = new Map();
const secureStorageStub = {
  secureStorage: {
    async getRawItem(key) {
      return storeBacking.has(key) ? storeBacking.get(key) : null;
    },
    async setRawItem(key, value) {
      storeBacking.set(key, value);
      return true;
    },
    async deleteRawItem(key) {
      storeBacking.delete(key);
    },
  },
};

async function loadTsModule(path) {
  let source;
  try {
    source = await read(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      assert.fail(`${path} should exist and export executable helpers`);
    }
    throw error;
  }

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
    require: (id) => (id.includes('secureStorage') ? secureStorageStub : requireForVm(id)),
  });
  return module.exports;
}

const cache = await loadTsModule('src/lib/userProfileCache.ts');
const { serializeProfile, parseCachedProfile, saveProfileCache, getCachedProfile, MAX_SERIALIZED_BYTES } = cache;

const realisticUser = {
  id: 'a3f1c2d4-5678-4abc-9def-0123456789ab',
  email: 'dr.veterinarian@homelesspetsfoundation.org',
  fullName: 'Dr. Alexandra Veterinarian-Hernandez DVM',
  role: 'owner',
  organizationId: 'b4e2d3c5-6789-4bcd-aef0-123456789abc',
  avatarUrl: 'https://shdzitupjltfyembqowp.supabase.co/storage/v1/object/public/avatars/a3f1c2d4.png',
};

test('serialized projection stays under the Keystore size budget', () => {
  const serialized = serializeProfile(realisticUser, 1765432100000);
  assert.ok(serialized, 'realistic profile should serialize');
  assert.ok(MAX_SERIALIZED_BYTES <= 1536, 'budget must stay under 1.5KB (Android Keystore ~2KB cap)');
  assert.ok(
    Buffer.byteLength(serialized, 'utf8') < 1536,
    `serialized profile must stay under 1.5KB, got ${Buffer.byteLength(serialized, 'utf8')}`
  );
  // Minimal projection only — never the full /auth/me response.
  const parsed = JSON.parse(serialized);
  assert.deepEqual(Object.keys(parsed).sort(), [
    'avatarUrl',
    'cachedAt',
    'email',
    'fullName',
    'id',
    'organizationId',
    'role',
  ]);
});

test('oversized avatarUrl is dropped rather than failing the write', () => {
  const longAvatar = { ...realisticUser, avatarUrl: `https://cdn.example.com/${'x'.repeat(2000)}.png` };
  const serialized = serializeProfile(longAvatar, 0);
  assert.ok(serialized, 'should still serialize without the avatar');
  assert.equal(JSON.parse(serialized).avatarUrl, null);
});

test('a projection that cannot fit even without avatarUrl is not written', () => {
  const huge = { ...realisticUser, fullName: 'X'.repeat(3000) };
  assert.equal(serializeProfile(huge, 0), null);
});

test('parseCachedProfile rejects user mismatch (shared-tablet user swap)', () => {
  const serialized = serializeProfile(realisticUser, 1765432100000);
  assert.ok(parseCachedProfile(serialized, realisticUser.id));
  assert.equal(parseCachedProfile(serialized, 'different-user-id'), null);
  assert.equal(parseCachedProfile(serialized, ''), null);
});

test('parseCachedProfile rejects corruption and malformed shapes', () => {
  assert.equal(parseCachedProfile(null, realisticUser.id), null);
  assert.equal(parseCachedProfile('not json {{{', realisticUser.id), null);
  assert.equal(parseCachedProfile('null', realisticUser.id), null);
  assert.equal(parseCachedProfile('42', realisticUser.id), null);
  assert.equal(
    parseCachedProfile(JSON.stringify({ id: realisticUser.id, email: 7 }), realisticUser.id),
    null
  );
});

test('save/get round-trip through the secureStorage raw accessors', async () => {
  storeBacking.clear();
  await saveProfileCache(realisticUser);
  const hit = await getCachedProfile(realisticUser.id);
  assert.ok(hit);
  assert.equal(hit.id, realisticUser.id);
  assert.equal(hit.fullName, realisticUser.fullName);
  assert.equal(hit.avatarUrl, realisticUser.avatarUrl);
  assert.ok(typeof hit.cachedAt === 'number' && hit.cachedAt > 0);
  // Same cache, different session user → miss.
  assert.equal(await getCachedProfile('someone-else'), null);
});

test('userProfileCache respects rule 3 (no direct SecureStore, no KEYS reach-in)', async () => {
  const source = await read('src/lib/userProfileCache.ts');
  assert.doesNotMatch(source, /expo-secure-store/);
  assert.doesNotMatch(source, /\bKEYS\b/);
  assert.match(source, /secureStorage\.getRawItem/);
  assert.match(source, /secureStorage\.setRawItem/);
});

test('AuthProvider confines cache fallback to the terminal-failure branch with bounded reads', async () => {
  const provider = await read('src/auth/AuthProvider.tsx');
  assert.match(provider, /withTimeout\(\s*getCachedProfile\(sessionUserId\),\s*3000/);
  assert.match(provider, /saveProfileCache\(liveUser\)\.catch\(\(\) => \{\}\)/);
  assert.match(provider, /setProfileSource\('cache'\)/);
  // The cache user must be applied through applyFetchedUser so rule-13
  // user-scoped storage (stash/draft setUserId) is configured.
  assert.match(provider, /applyFetchedUser\(\{\s*id: cached\.id/);
});

test('OfflineBanner renders only for cached profile source', async () => {
  const banner = await read('src/components/OfflineBanner.tsx');
  assert.match(banner, /profileSource !== 'cache'/);
  const layout = await read('app/(app)/_layout.tsx');
  assert.match(layout, /<OfflineBanner \/>/);
});
