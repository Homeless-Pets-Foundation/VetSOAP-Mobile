// Codex round-10 regressions (PR #143): bound persisted list cardinality +
// per-query expiry, recovery-safe/guarded device-limit sign-out, and
// post-submit back navigation returning to the recordings list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

// Re-implement isPersistableListVariant to lock its contract (grep keeps the
// source in sync via query-persistence-guard).
function isPersistableListVariant(queryKey) {
  const [rootKey, sub] = queryKey;
  if (rootKey === 'patients' && sub === 'list') return !queryKey[2];
  if (rootKey === 'recordings' && sub === 'list') {
    return (
      !queryKey[2] &&
      (queryKey[3] === 'all' || queryKey[3] == null) &&
      (queryKey[4] === 'any' || queryKey[4] == null)
    );
  }
  if (rootKey === 'recordings' && sub === 'drafts') return !queryKey[3];
  return true;
}

test('only default (unsearched/unfiltered) list variants are persistable', () => {
  // Default variants persist.
  assert.ok(isPersistableListVariant(['patients', 'list', '']));
  assert.ok(isPersistableListVariant(['recordings', 'list', '', 'all', 'any', 'submittedAt-desc']));
  assert.ok(isPersistableListVariant(['recordings', 'drafts', 'list', '', 'desc']));
  // Home's recent + detail queries are unaffected.
  assert.ok(isPersistableListVariant(['recordings', 'recent']));
  assert.ok(isPersistableListVariant(['recording', 'abc-123']));
  assert.ok(isPersistableListVariant(['patient', 'abc-123', 'recordings', 20]));
  // Search / filter variants do NOT persist — this is what bounds the snapshot.
  assert.ok(!isPersistableListVariant(['patients', 'list', 'bella']));
  assert.ok(!isPersistableListVariant(['recordings', 'list', 'rex', 'all', 'any', 'submittedAt-desc']));
  assert.ok(!isPersistableListVariant(['recordings', 'list', '', 'processing', 'any', 'submittedAt-desc']));
  assert.ok(!isPersistableListVariant(['recordings', 'list', '', 'all', 'needs_review', 'submittedAt-desc']));
  assert.ok(!isPersistableListVariant(['recordings', 'drafts', 'list', 'rex', 'desc']));
});

test('device-limit sign-out is recovery-aware and fully busy-guarded', async () => {
  const modal = await read('src/components/DeviceLimitModal.tsx');
  // signingOut joins the shared busy guard so a device Revoke can't fire while
  // the API token is still valid during recovery preservation.
  assert.match(modal, /const isBusy = revokingId !== null \|\| retrying \|\| signingOut;/);
  assert.match(modal, /disabled=\{isBusy\}/);
  // Revoke row disables on the shared guard, not just revokingId.
  assert.doesNotMatch(modal, /disabled=\{revokingId !== null\}/);
  // support_staff uses recoveryMode 'required' with the retry/destructive
  // escalation, mirroring Settings.
  assert.match(modal, /user\?\.role === 'support_staff' \? 'required' : 'best_effort'/);
  assert.match(modal, /signOut\(\{ recoveryMode \}\)/);
  assert.match(modal, /error\.message === SUPPORT_STAFF_RECOVERY_PRESERVE_FAILED/);
  assert.match(modal, /onPress: \(\) => runSignOut\('required'\)/);
  assert.match(modal, /onPress: \(\) => runSignOut\('destructive'\)/);
});

test('post-submit detail Back returns to the recordings list, not the reset form', async () => {
  const rec = await read('app/(app)/(tabs)/record.tsx');
  // Single-submit push tags the origin…
  assert.match(rec, /\/recordings\/\$\{serverRecordingId\}\?from=submit/);
  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');
  // …and the detail Back honors it instead of router.back()-ing into the form.
  assert.match(detail, /const \{ id, from \} = useLocalSearchParams/);
  assert.match(detail, /if \(from === 'submit'\) \{\s*\n\s*router\.replace\('\/recordings'\);/);
});
