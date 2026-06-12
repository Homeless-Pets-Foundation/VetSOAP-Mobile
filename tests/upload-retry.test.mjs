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
  // Android okhttp SocketTimeoutException — expo-file-system upload stalled
  // mid-body and the socket read/write timed out. The literal message okhttp
  // surfaces is the single word "timeout" (Teat2 incident 2026-05-25:
  // client_telemetry phase=r2_put, message="timeout", okhttp 4.12.0). Before
  // this fingerprint was added the timeout was classified non-transient, so
  // uploadOnceWithRetry threw on the first attempt with no auto-retry and the
  // user had to manually resubmit twice before a fresh socket succeeded.
  assert.equal(isTransientUploadError(new Error('timeout')), true);
  assert.equal(isTransientUploadError(new Error('java.net.SocketTimeoutException: timeout')), true);
  assert.equal(isTransientUploadError(new Error('SocketTimeoutException')), true);
});

test('isTransientUploadError refuses HTTP-status messages (those route through isStalePresignError)', async () => {
  const { isTransientUploadError } = await loadTsModule('src/api/uploadRetry.ts');

  assert.equal(isTransientUploadError(new Error('Upload to storage failed (HTTP 403). Please try again.')), false);
  assert.equal(isTransientUploadError(new Error('Upload to storage failed (HTTP 500). Please try again.')), false);
  // The 10-minute withTimeout hard-cap ("Upload timed out…") is deliberately
  // NOT transient: a genuinely 10-min-stalled upload should fail fast, not
  // auto-retry up to 3 × 10 min. "timed out" (two words) must stay outside the
  // \btimeout\b socket-timeout fingerprint added above.
  assert.equal(isTransientUploadError(new Error('Upload timed out. Please check your connection and try again.')), false);
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

test('uploadTimeoutMs scales with file size and clamps to [10min, 30min]', async () => {
  const { uploadTimeoutMs, UPLOAD_TIMEOUT_MIN_MS, UPLOAD_TIMEOUT_MAX_MS } =
    await loadTsModule('src/api/uploadRetry.ts');

  const MB = 1024 * 1024;

  // Small files keep the proven 10-min floor (Sentry REACT-NATIVE-N regression
  // guard — must NOT shrink the budget that already works for short uploads).
  assert.equal(uploadTimeoutMs(1 * MB), UPLOAD_TIMEOUT_MIN_MS);
  assert.equal(uploadTimeoutMs(5 * MB), UPLOAD_TIMEOUT_MIN_MS);

  // The 250 MB ceiling case (MAX_FILE_SIZE_BYTES) clamps to the 30-min cap so
  // a large file on a slow link gets headroom but never blocks the UI forever.
  assert.equal(uploadTimeoutMs(250 * MB), UPLOAD_TIMEOUT_MAX_MS);

  // A mid-size file lands strictly between the bounds and above the old fixed
  // 10-min cap.
  const mid = uploadTimeoutMs(50 * MB);
  assert.ok(mid > UPLOAD_TIMEOUT_MIN_MS && mid < UPLOAD_TIMEOUT_MAX_MS, `mid was ${mid}`);

  // Degenerate sizes (0, NaN, negative) fall back to the floor, never below it.
  assert.equal(uploadTimeoutMs(0), UPLOAD_TIMEOUT_MIN_MS);
  assert.equal(uploadTimeoutMs(NaN), UPLOAD_TIMEOUT_MIN_MS);
  assert.equal(uploadTimeoutMs(-1), UPLOAD_TIMEOUT_MIN_MS);

  // Monotonic non-decreasing across the range.
  const sizes = [0, 10 * MB, 30 * MB, 80 * MB, 150 * MB, 250 * MB];
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(
      uploadTimeoutMs(sizes[i]) >= uploadTimeoutMs(sizes[i - 1]),
      `non-monotonic at ${sizes[i]}`
    );
  }
});

test('uploadTimeoutMs widens the budget under parallelism but keeps the clamps', async () => {
  const { uploadTimeoutMs, UPLOAD_TIMEOUT_MIN_MS, UPLOAD_TIMEOUT_MAX_MS } =
    await loadTsModule('src/api/uploadRetry.ts');

  const MB = 1024 * 1024;

  // Concurrent lanes share the link, so the per-lane budget must not shrink.
  for (const size of [1 * MB, 30 * MB, 80 * MB, 250 * MB]) {
    assert.ok(
      uploadTimeoutMs(size, 3) >= uploadTimeoutMs(size, 1),
      `parallelism must never shrink the budget (size=${size})`
    );
  }

  // A mid-size segment that fits the floor solo needs more headroom at 3 lanes.
  assert.equal(uploadTimeoutMs(1 * MB, 3), UPLOAD_TIMEOUT_MIN_MS, 'tiny files keep the floor');
  assert.ok(uploadTimeoutMs(30 * MB, 3) > uploadTimeoutMs(30 * MB), '30MB at 3 lanes needs > solo budget');

  // The ceiling still binds — no unbounded waits.
  assert.equal(uploadTimeoutMs(250 * MB, 3), UPLOAD_TIMEOUT_MAX_MS);

  // Degenerate parallelism values behave like 1.
  assert.equal(uploadTimeoutMs(30 * MB, 0), uploadTimeoutMs(30 * MB));
  assert.equal(uploadTimeoutMs(30 * MB, NaN), uploadTimeoutMs(30 * MB));
  assert.equal(uploadTimeoutMs(30 * MB, undefined), uploadTimeoutMs(30 * MB));
});

test('runWithConcurrency runs every index once and respects the concurrency bound', async () => {
  const { runWithConcurrency } = await loadTsModule('src/api/uploadRetry.ts');

  const started = [];
  let inFlight = 0;
  let maxInFlight = 0;

  await runWithConcurrency(10, 3, async (i) => {
    started.push(i);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // Vary completion order so the cursor hands out indexes out of lockstep.
    await new Promise((r) => setTimeout(r, (i % 3) * 5));
    inFlight--;
  });

  assert.deepEqual([...started].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(started.length, 10, 'each index must run exactly once');
  assert.ok(maxInFlight <= 3, `in-flight exceeded the bound: ${maxInFlight}`);
  assert.ok(maxInFlight >= 2, 'pool should actually run tasks concurrently');
});

test('runWithConcurrency aborts on first failure: no new tasks start, first error identity rethrown', async () => {
  const { runWithConcurrency } = await loadTsModule('src/api/uploadRetry.ts');

  const boom = new Error('segment 2 died');
  boom.uploadPhase = 'r2_put';
  const started = [];

  let caught;
  try {
    await runWithConcurrency(10, 2, async (i) => {
      started.push(i);
      await new Promise((r) => setTimeout(r, 5));
      if (i === 2) throw boom;
    });
  } catch (e) {
    caught = e;
  }

  assert.equal(caught, boom, 'must rethrow the same Error instance (phase tag intact)');
  assert.equal(caught.uploadPhase, 'r2_put');
  // With concurrency 2 and the failure at index 2, at most one more task
  // (index 3) was already in flight when the failure landed; everything
  // after must never start.
  assert.ok(!started.includes(9), 'tail tasks must not start after a failure');
  assert.ok(started.length <= 4, `expected an early stop, but ${started.length} tasks started`);
});

test('runWithConcurrency handles degenerate inputs', async () => {
  const { runWithConcurrency } = await loadTsModule('src/api/uploadRetry.ts');

  // Zero / negative / non-integer totals resolve without invoking the task.
  let calls = 0;
  await runWithConcurrency(0, 3, async () => { calls++; });
  await runWithConcurrency(-1, 3, async () => { calls++; });
  assert.equal(calls, 0);

  // Concurrency larger than total still runs each index exactly once.
  const seen = [];
  await runWithConcurrency(2, 8, async (i) => { seen.push(i); });
  assert.deepEqual([...seen].sort(), [0, 1]);

  // Concurrency below 1 degrades to sequential, not zero workers.
  const sequential = [];
  await runWithConcurrency(3, 0, async (i) => { sequential.push(i); });
  assert.deepEqual(sequential, [0, 1, 2]);
});
