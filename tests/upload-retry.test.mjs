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
  // Share Error (and a few other commonly-needed globals) with the new vm
  // context so `err instanceof Error` checks inside the loaded module match
  // Errors constructed by the test code. Without this, every vm context gets
  // its own Error class and the cross-context instanceof check silently
  // returns false — masking real predicate behavior. The existing
  // security-mfa.test.mjs pattern doesn't hit this because mfaPolicy uses
  // duck-typing on `.code` instead of `instanceof`.
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require: requireForVm,
    Error,
    TypeError,
    RangeError,
    Promise,
    setTimeout,
    clearTimeout,
    console,
  });
  return module.exports;
}

test('uploadRetry module loads with no side-effect imports', async () => {
  const mod = await loadTsModule('src/api/uploadRetry.ts');
  assert.equal(typeof mod.isTransientUploadError, 'function');
  assert.equal(typeof mod.isStalePresignError, 'function');
  assert.equal(typeof mod.getUploadPhase, 'function');
  assert.equal(typeof mod.getUploadHttpStatus, 'function');
  assert.equal(typeof mod.tagPhase, 'function');
  assert.equal(typeof mod.phaseError, 'function');
});

test('isTransientUploadError matches every fingerprint we have in production', async () => {
  const { isTransientUploadError } = await loadTsModule('src/api/uploadRetry.ts');

  // Sentry RN-4 — Android UnknownHostException via expo-file-system.
  assert.equal(
    isTransientUploadError(new Error('Unable to resolve host "captivet-recordings.x.r2.cloudflarestorage.com": No address associated with hostname')),
    true
  );
  // Native socket layer drops.
  assert.equal(isTransientUploadError(new Error('Failed to connect to captivet-recordings.x.r2.cloudflarestorage.com/192.168.1.1')), true);
  assert.equal(isTransientUploadError(new Error('Network request failed')), true);
  assert.equal(isTransientUploadError(new Error('ECONNRESET')), true);
  assert.equal(isTransientUploadError(new Error('ETIMEDOUT')), true);
  assert.equal(isTransientUploadError(new Error('EHOSTUNREACH')), true);
  assert.equal(isTransientUploadError(new Error('ENETUNREACH')), true);
  assert.equal(isTransientUploadError(new Error('EAI_AGAIN dns lookup failed')), true);
});

test('isTransientUploadError refuses HTTP-status messages (those route through isStalePresignError)', async () => {
  const { isTransientUploadError } = await loadTsModule('src/api/uploadRetry.ts');

  assert.equal(isTransientUploadError(new Error('Upload to storage failed (HTTP 403). Please try again.')), false);
  assert.equal(isTransientUploadError(new Error('Upload to storage failed (HTTP 500). Please try again.')), false);
  // Non-Error inputs are silently rejected — the retry loop expects Errors only.
  assert.equal(isTransientUploadError('Failed to connect'), false);
  assert.equal(isTransientUploadError(null), false);
  assert.equal(isTransientUploadError(undefined), false);
  assert.equal(isTransientUploadError({}), false);
});

test('isStalePresignError matches httpStatus 401 and 403 ONLY', async () => {
  const { isStalePresignError, phaseError } = await loadTsModule('src/api/uploadRetry.ts');

  const make = (status) => {
    try {
      phaseError('r2_put', `Upload to storage failed (HTTP ${status}). Please try again.`, status);
    } catch (e) {
      return e;
    }
  };

  assert.equal(isStalePresignError(make(401)), true, '401 must be considered stale-presign');
  assert.equal(isStalePresignError(make(403)), true, '403 must be considered stale-presign');

  // Everything else, including the other 4xx codes that genuinely mean
  // the upload was refused, must NOT retry — they are deterministic and
  // would just loop.
  assert.equal(isStalePresignError(make(400)), false);
  assert.equal(isStalePresignError(make(404)), false);
  assert.equal(isStalePresignError(make(409)), false);
  assert.equal(isStalePresignError(make(429)), false);
  assert.equal(isStalePresignError(make(500)), false);
  assert.equal(isStalePresignError(make(502)), false);
  assert.equal(isStalePresignError(make(503)), false);

  // Errors without httpStatus (network failures, plain Errors) must not
  // accidentally trip the presign path — they go through
  // isTransientUploadError instead.
  assert.equal(isStalePresignError(new Error('Failed to connect')), false);
  assert.equal(isStalePresignError(new Error('Unable to resolve host x.r2.cloudflarestorage.com')), false);
});

test('phaseError attaches httpStatus only when explicitly provided', async () => {
  const { phaseError, getUploadHttpStatus, getUploadPhase } = await loadTsModule('src/api/uploadRetry.ts');

  let caught;
  try { phaseError('r2_put', 'No status here'); } catch (e) { caught = e; }
  assert.equal(getUploadPhase(caught), 'r2_put');
  assert.equal(getUploadHttpStatus(caught), undefined, 'absent httpStatus must not become 0 or null');

  let caughtWithStatus;
  try { phaseError('r2_put', 'has status', 403); } catch (e) { caughtWithStatus = e; }
  assert.equal(getUploadHttpStatus(caughtWithStatus), 403);
});

test('tagPhase preserves the original Error identity (so stack traces survive)', async () => {
  const { tagPhase, getUploadPhase } = await loadTsModule('src/api/uploadRetry.ts');

  const original = new Error('boom');
  let caught;
  try { tagPhase(original, 'presign'); } catch (e) { caught = e; }
  assert.equal(caught, original, 'tagPhase must re-throw the same Error instance');
  assert.equal(getUploadPhase(caught), 'presign');
});

test('tagPhase wraps non-Error throwables instead of dropping the phase tag', async () => {
  const { tagPhase, getUploadPhase } = await loadTsModule('src/api/uploadRetry.ts');

  let caught;
  try { tagPhase('a string thrown', 'r2_put'); } catch (e) { caught = e; }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, 'a string thrown');
  assert.equal(getUploadPhase(caught), 'r2_put');

  let caughtFromNull;
  try { tagPhase(null, 'confirm'); } catch (e) { caughtFromNull = e; }
  assert.ok(caughtFromNull instanceof Error);
  assert.equal(caughtFromNull.message, 'Upload failed');
  assert.equal(getUploadPhase(caughtFromNull), 'confirm');
});

test('getUploadPhase defaults to "unknown" for untagged or non-Error inputs', async () => {
  const { getUploadPhase } = await loadTsModule('src/api/uploadRetry.ts');

  assert.equal(getUploadPhase(new Error('plain')), 'unknown');
  assert.equal(getUploadPhase('string'), 'unknown');
  assert.equal(getUploadPhase(null), 'unknown');
  assert.equal(getUploadPhase(undefined), 'unknown');
});

test('recordings.ts still re-exports the public surface for back-compat', async () => {
  const src = await read('src/api/recordings.ts');

  assert.match(
    src,
    /export \{\s*isTransientUploadError,\s*isStalePresignError,\s*getUploadPhase,\s*getUploadHttpStatus,\s*\} from '\.\/uploadRetry';/
  );
  assert.match(src, /export type \{ UploadPhase, TaggedError \} from '\.\/uploadRetry';/);
});

test('recordings.ts no longer defines duplicate predicates locally', async () => {
  const src = await read('src/api/recordings.ts');

  // The body of the predicate must live in uploadRetry.ts only. If a future
  // refactor reintroduces the inline definition, the executable tests above
  // would silently test the old copy via the re-export — this assertion
  // prevents that drift.
  assert.doesNotMatch(src, /^export function isTransientUploadError\(/m);
  assert.doesNotMatch(src, /^export function isStalePresignError\(/m);
  assert.doesNotMatch(src, /^const TRANSIENT_R2_ERROR_RE\s*=/m);
});
