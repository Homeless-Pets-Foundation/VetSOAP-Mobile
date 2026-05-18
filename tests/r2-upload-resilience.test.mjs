import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('uploadRetry.ts exports isTransientUploadError, isStalePresignError, getUploadHttpStatus', async () => {
  const src = await read('src/api/uploadRetry.ts');

  assert.match(src, /export function isTransientUploadError\(/);
  assert.match(src, /export function isStalePresignError\(/);
  assert.match(src, /export function getUploadHttpStatus\(/);
});

test('recordings.ts re-exports the upload-retry helpers for back-compat', async () => {
  const src = await read('src/api/recordings.ts');

  assert.match(
    src,
    /export \{\s*isTransientUploadError,\s*isStalePresignError,\s*getUploadPhase,\s*getUploadHttpStatus,\s*\} from '\.\/uploadRetry';/
  );
  assert.match(src, /export type \{ UploadPhase, TaggedError \} from '\.\/uploadRetry';/);
});

test('isStalePresignError returns true only for 401 and 403 httpStatus', async () => {
  const src = await read('src/api/uploadRetry.ts');

  const match = src.match(/export function isStalePresignError\([\s\S]*?\n\}/);
  assert.ok(match, 'isStalePresignError block should be findable');
  const body = match[0];
  assert.match(body, /status === 401 \|\| status === 403/);
  assert.match(body, /\(err as TaggedError\)\.httpStatus/);
});

test('phaseError accepts httpStatus and TaggedError carries it', async () => {
  const src = await read('src/api/uploadRetry.ts');

  assert.match(
    src,
    /export type TaggedError = Error & \{ uploadPhase\?: UploadPhase; httpStatus\?: number \}/
  );
  assert.match(
    src,
    /export function phaseError\(phase: UploadPhase, message: string, httpStatus\?: number\): never/
  );
  assert.match(src, /if \(httpStatus !== undefined\) err\.httpStatus = httpStatus;/);
});

test('both r2_put status throws propagate result.status to phaseError', async () => {
  const src = await read('src/api/recordings.ts');

  // Single-file upload path
  assert.match(
    src,
    /phaseError\(\s*'r2_put',\s*`Upload to storage failed \(HTTP \$\{result\?\.status \?\? 'unknown'\}\)\. Please try again\.`,\s*result\?\.status\s*\)/
  );
  // Multi-segment upload path
  assert.match(
    src,
    /phaseError\(\s*'r2_put',\s*`Upload of segment \$\{i \+ 1\} failed \(HTTP \$\{result\?\.status \?\? 'unknown'\}\)\. Please try again\.`,\s*result\?\.status\s*\)/
  );
});

test('uploadOnceWithRetry re-presigns once on stale 401/403, never beyond attempt 1', async () => {
  const src = await read('src/api/recordings.ts');

  // The gate must combine transient OR stale-presign-with-attempt-cap.
  assert.match(src, /const transient = isTransientUploadError\(err\);/);
  assert.match(
    src,
    /const stalePresign = attempt === 1 && isStalePresignError\(err\);/
  );
  assert.match(src, /if \(!transient && !stalePresign\) throw err;/);
  // Stale-presign retry must skip the long network-wait — the socket worked,
  // the URL was the problem. Regression check: a future refactor that drops
  // this branch will silently make stale-presign retries wait up to 15s for
  // nothing.
  assert.match(
    src,
    /const online = stalePresign \? true : await waitForNetworkOnline\(NET_RECOVERY_WAIT_MS\);/
  );
  // Distinct breadcrumb so retry attribution in Sentry separates the modes.
  assert.match(src, /'r2_put_403_retry'/);
  assert.match(src, /'r2_put_retry'/);
  assert.match(src, /http_status: \(err as TaggedError\)\.httpStatus/);
});

test('analytics.ts adds recording_auto_stashed event with AutoStashReason union', async () => {
  const src = await read('src/lib/analytics.ts');

  assert.match(src, /export type AutoStashReason = 'r2_put_dead_network';/);
  assert.match(
    src,
    /\| \{ name: 'recording_auto_stashed'; props: \{ reason: AutoStashReason; slot_index: number; segment_count: number; duration_s: number \} \}/
  );
});

test('record.tsx imports isTransientUploadError from recordings module', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');

  assert.match(
    src,
    /import \{ recordingsApi, getUploadPhase, isTransientUploadError \} from '\.\.\/\.\.\/\.\.\/src\/api\/recordings';/
  );
});

test('record.tsx flags auto-stash eligibility only on transient r2_put exhaustion', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');

  // The flag is set ONLY when phase === 'r2_put' AND transient. Narrower gates
  // matter — a presign 403 or a silence-check throw must NOT trigger auto-stash.
  assert.match(
    src,
    /if \(phase === 'r2_put' && isTransientUploadError\(error\)\) \{\s*autoStashableFailuresRef\.current\.add\(slot\.id\);\s*\}/
  );
  // Fresh attempt clears any stale flag so a retry-then-different-failure
  // doesn't accidentally stash.
  assert.match(
    src,
    /autoStashableFailuresRef\.current\.delete\(slot\.id\);/
  );
});

test('record.tsx auto-stash helper consumes flags, stashes, emits per-slot analytics, navigates', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');

  // Helper present
  assert.match(src, /const tryAutoStashOnNetworkDeath = useCallback\(/);
  // Eligibility derives from the ref, not a closure variable that could be stale
  assert.match(
    src,
    /autoStashableFailuresRef\.current\.has\(id\)/
  );
  // Flags are CONSUMED so a follow-up failure doesn't re-trigger
  assert.match(
    src,
    /eligibleIds\.forEach\(\(id\) => autoStashableFailuresRef\.current\.delete\(id\)\)/
  );
  // Stash is via the existing hook, not a bespoke duplicate path
  assert.match(src, /const success = await stashSession\(session\);/);
  // Per-slot analytics — one event per eligible slot, not aggregate
  assert.match(src, /name: 'recording_auto_stashed'/);
  assert.match(src, /reason: 'r2_put_dead_network'/);
  // Reset + nav home after stash commits
  assert.match(src, /releaseResumedStashIfAny\(\);\s*resetSession\(\);/);
});

test('record.tsx submit handlers route failures through auto-stash before showing generic alert', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');

  // Single submit: null return ⇒ try auto-stash for the one slot
  assert.match(
    src,
    /await tryAutoStashOnNetworkDeath\(\[slotId\]\);/
  );

  // Submit-all: collect failed slot ids and pass them, only show generic alert if stash didn't catch
  assert.match(
    src,
    /const failedSlotIds: string\[\] = \[\];/
  );
  assert.match(
    src,
    /failedSlotIds\.push\(slot\.id\)/
  );
  assert.match(
    src,
    /const stashed = await tryAutoStashOnNetworkDeath\(failedSlotIds\);\s*if \(!stashed\) \{/
  );
});
