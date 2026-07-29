// Attention Feed — query/envelope/cache/persistence contract
// (verification section 3 of the 2026-07-29 plan). A failed, blocked, or
// truncated response must NEVER be presentable as a clean feed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { loadTsModule } from './helpers/loadTs.mjs';

const root = new URL('../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

const FEED = await loadTsModule('src/lib/attentionFeed.ts');

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const OWNER = { id: 'aaaaaaaa-0000-4000-8000-000000000001', role: 'owner' };

function uuid(n) {
  const hex = String(n).padStart(12, '0');
  return `11111111-1111-4111-8111-${hex}`;
}

function row(overrides = {}) {
  return {
    id: uuid(1),
    userId: OWNER.id,
    status: 'completed',
    patientName: 'Bella',
    clientName: null,
    species: null,
    breed: null,
    appointmentType: null,
    qualityWarnings: [],
    aiExtractedMetadata: { review: 'confirmed' },
    submittedAt: '2026-07-29T11:00:00.000Z',
    updatedAt: '2026-07-29T11:00:00.000Z',
    ...overrides,
  };
}

function envelope(rows, pagination) {
  return {
    data: rows,
    ...(pagination === undefined ? {} : { pagination }),
  };
}

const PAGE_OPTS = { page: 1, limit: 100 };

function parse(raw) {
  return FEED.parseAttentionEnvelope(raw, PAGE_OPTS);
}

function expectMalformed(raw, label) {
  assert.throws(
    () => parse(raw),
    (error) => error.code === 'ATTENTION_RESPONSE_MALFORMED',
    label
  );
}

// ─── Envelope validation ───────────────────────────────────────────────────

test('a valid page-1/limit-100 envelope parses to projected rows', () => {
  const parsed = parse(envelope([row()], { page: 1, limit: 100, total: 1, totalPages: 1 }));
  assert.equal(parsed.data.length, 1);
  assert.deepEqual(plain(Object.keys(parsed.data[0]).sort()), [
    'aiExtractedMetadata',
    'appointmentType',
    'breed',
    'clientName',
    'id',
    'patientName',
    'qualityWarnings',
    'species',
    'status',
    'submittedAt',
    'updatedAt',
    'userId',
  ]);
});

test('raw failure/audio/detail fields cannot enter the stored envelope', () => {
  const parsed = parse(
    envelope(
      [
        {
          ...row({ status: 'failed' }),
          errorMessage: 'TypeError: boom at Patient Bella',
          errorCode: 'LEGACY',
          audioFileUrl: 'https://example.invalid/a.m4a',
          processingStartedAt: '2026-07-29T10:00:00.000Z',
          transcriptText: 'clinical text',
        },
      ],
      { page: 1, limit: 100, total: 1, totalPages: 1 }
    )
  );
  const serialized = JSON.stringify(plain(parsed));
  assert.ok(!serialized.includes('TypeError'));
  assert.ok(!serialized.includes('example.invalid'));
  assert.ok(!serialized.includes('clinical text'));
  assert.ok(!serialized.includes('processingStartedAt'));
});

test('a structurally invalid row makes the RESPONSE malformed, never a silent drop', () => {
  expectMalformed(envelope([row(), { nope: true }]), 'garbage row');
  expectMalformed(envelope([{ ...row(), status: 'weird' }]), 'unknown status');
  expectMalformed(envelope([{ ...row(), qualityWarnings: 'nope' }]), 'bad warnings');
  expectMalformed(envelope('nope'), 'non-array data');
  expectMalformed('nope', 'non-object body');
});

test('malformed / non-UUID ids fail the envelope instead of routing elsewhere', () => {
  expectMalformed(envelope([{ ...row(), id: '../../evil' }]), 'path traversal id');
  expectMalformed(envelope([{ ...row(), id: 'not-a-uuid' }]), 'non-uuid id');
  expectMalformed(envelope([{ ...row(), userId: 'not-a-uuid' }]), 'non-uuid userId');
  expectMalformed(envelope([{ ...row(), updatedAt: 'x'.repeat(65) }]), 'unbounded timestamp');
});

test('duplicate ids or an over-cap page cannot manufacture complete coverage', () => {
  expectMalformed(
    envelope([row({ id: uuid(1) }), row({ id: uuid(1) })], {
      page: 1,
      limit: 100,
      total: 2,
      totalPages: 1,
    }),
    'duplicate ids'
  );
  const overCap = Array.from({ length: 101 }, (_, i) => row({ id: uuid(i + 1) }));
  expectMalformed(envelope(overCap), 'more than the requested cap');
});

test('an inconsistent pagination proof is malformed; an ABSENT one is unknown coverage', () => {
  expectMalformed(envelope([row()], { page: 2, limit: 100, total: 1, totalPages: 1 }), 'page echo');
  expectMalformed(envelope([row()], { page: 1, limit: 20, total: 1, totalPages: 1 }), 'limit echo');
  expectMalformed(
    envelope([row()], { page: 1, limit: 100, total: 500, totalPages: 1 }),
    'totalPages inconsistent'
  );
  expectMalformed(envelope([row()], { page: 1, limit: 100, total: -1, totalPages: 0 }), 'negative total');

  const noProof = parse(envelope([row()]));
  assert.equal(noProof.pagination, null);
  assert.equal(FEED.attentionCoverage(noProof), 'unknown');

  const junkProof = parse(envelope([row()], { total: 'many' }));
  assert.equal(junkProof.pagination, null);
  assert.equal(FEED.attentionCoverage(junkProof), 'unknown');
});

test('coverage is complete only when the page covers the server result set', () => {
  const complete = parse(envelope([row()], { page: 1, limit: 100, total: 1, totalPages: 1 }));
  assert.equal(FEED.attentionCoverage(complete), 'complete');

  const truncated = parse(envelope([row()], { page: 1, limit: 100, total: 500, totalPages: 5 }));
  assert.equal(FEED.attentionCoverage(truncated), 'recent_page_only');

  const emptyPage = parse(envelope([], { page: 1, limit: 100, total: 0, totalPages: 0 }));
  assert.equal(FEED.attentionCoverage(emptyPage), 'complete');
  // Some server versions report a zero-total page as 1 page.
  const emptyOnePage = parse(envelope([], { page: 1, limit: 100, total: 0, totalPages: 1 }));
  assert.equal(FEED.attentionCoverage(emptyOnePage), 'complete');

  assert.equal(FEED.attentionCoverage(null), 'unknown');
});

test('a NON-EMPTY page of perfectly clean recordings derives zero items', () => {
  const parsed = parse(
    envelope(
      [row({ id: uuid(1) }), row({ id: uuid(2) }), row({ id: uuid(3) })],
      { page: 1, limit: 100, total: 3, totalPages: 1 }
    )
  );
  const derived = FEED.deriveRecordingAttention(parsed.data, OWNER, {
    nowMs: NOW,
    recordFirstEnabled: true,
  });
  assert.equal(derived.items.length, 0);
  assert.equal(derived.classificationComplete, true);
  assert.equal(FEED.attentionCoverage(parsed), 'complete');
  // "empty server page" is therefore the WRONG test for the clean state.
  assert.ok(parsed.data.length > 0);
});

test('a pagination-valid response can still be classification-PARTIAL', () => {
  const parsed = parse(
    envelope([row({ status: 'uploaded', updatedAt: 'not-a-date' })], {
      page: 1,
      limit: 100,
      total: 1,
      totalPages: 1,
    })
  );
  assert.equal(FEED.attentionCoverage(parsed), 'complete');
  const derived = FEED.deriveRecordingAttention(parsed.data, OWNER, {
    nowMs: NOW,
    recordFirstEnabled: true,
  });
  assert.equal(derived.classificationComplete, false);
  assert.equal(derived.uncheckableTimingRowCount, 1);
  assert.equal(derived.items.length, 0, 'a guess is never rendered as a stuck row');
});

test('the malformed error carries generic copy and never the payload', () => {
  try {
    parse({ data: [{ id: 'evil', patientName: 'Bella', clientName: 'Henderson' }] });
    assert.fail('should have thrown');
  } catch (error) {
    assert.equal(error.code, 'ATTENTION_RESPONSE_MALFORMED');
    assert.ok(!error.message.includes('Bella'));
    assert.ok(!error.message.includes('Henderson'));
    assert.match(error.message, /Could not read the recordings response/);
  }
});

// ─── Poll + tick gating (no network needed to cross a boundary) ────────────

test('the minute tick alone crosses 5/20/35-minute and 7-day boundaries', () => {
  const uploaded = row({ status: 'uploaded', updatedAt: new Date(NOW - 4 * MINUTE).toISOString() });
  const before = FEED.deriveRecordingAttention([uploaded], OWNER, {
    nowMs: NOW,
    recordFirstEnabled: true,
  });
  assert.equal(before.items.length, 0);
  const after = FEED.deriveRecordingAttention([uploaded], OWNER, {
    nowMs: NOW + 2 * MINUTE,
    recordFirstEnabled: true,
  });
  assert.equal(after.items.length, 1, 'a clock tick alone produced the stuck row');

  const warned = row({
    qualityWarnings: ['Noisy.'],
    submittedAt: new Date(NOW - 7 * DAY + MINUTE).toISOString(),
  });
  assert.equal(
    FEED.deriveRecordingAttention([warned], OWNER, { nowMs: NOW, recordFirstEnabled: true }).items
      .length,
    1
  );
  assert.equal(
    FEED.deriveRecordingAttention([warned], OWNER, {
      nowMs: NOW + 2 * MINUTE,
      recordFirstEnabled: true,
    }).items.length,
    0,
    'the 7-day expiry needs no refetch'
  );
});

test('polling uses ONLY the explicit pollable statuses', () => {
  for (const status of [
    'uploading',
    'uploaded',
    'transcribing',
    'transcribed',
    'generating',
    'retry_scheduled',
  ]) {
    assert.equal(FEED.hasPollableAttentionRow([row({ status })]), true, status);
  }
  for (const status of ['completed', 'failed', 'pending_metadata', 'draft']) {
    assert.equal(FEED.hasPollableAttentionRow([row({ status })]), false, status);
  }
});

// ─── Hook / cache / persistence wiring ─────────────────────────────────────

test('the attention key cannot collide with Home\'s five-row recent query', async () => {
  const cache = await read('src/lib/recordingQueryCache.ts');
  assert.match(cache, /ATTENTION_QUERY_KEY = \['recordings', 'attention', 'updated-v1'\]/);
  const home = await read('app/(app)/(tabs)/index.tsx');
  assert.match(home, /queryKey: \['recordings', 'recent'\]/);
  assert.match(home, /recordingsApi\.list\(\{ limit: 5/);

  const hook = await read('src/hooks/useAttentionFeed.ts');
  assert.match(hook, /queryKey: \[\.\.\.ATTENTION_QUERY_KEY\]/);
  assert.match(hook, /limit: ATTENTION_PAGE_LIMIT/);
  assert.doesNotMatch(hook, /queryKey: \['recordings', 'recent'\]/);
});

test('the stored attention data is the ENVELOPE; derived and local items stay outside it', async () => {
  const hook = await read('src/hooks/useAttentionFeed.ts');
  assert.match(hook, /queryFn: fetchAttentionPage/);
  assert.match(hook, /Promise<AttentionEnvelope>/);
  // Derivation is a memoized pure call over the stored rows, not cached data.
  assert.match(hook, /useMemo\(\s*\n\s*\(\) => deriveRecordingAttention\(rows, user/);
  // Local synthetic rows live under their own user-keyed query.
  assert.match(hook, /export function attentionLocalQueryKey/);
  assert.match(hook, /ATTENTION_LOCAL_QUERY_ROOT = 'attention'/);
  assert.match(hook, /ATTENTION_LOCAL_QUERY_SUB = 'local-unsent'/);
});

test('the attention page is excluded from disk persistence', async () => {
  const persistence = await read('src/lib/queryPersistence.ts');
  assert.match(persistence, /root === 'recordings' && sub === 'attention'/);
  assert.match(persistence, /return false;/);
  // ...and the post-review-removal list key persists its DEFAULT variant only.
  assert.match(
    persistence,
    /\['recordings', 'list', search, status, sort\]/
  );
  assert.doesNotMatch(persistence, /queryKey\[4\] === 'any'/);
});

test('device-registration pending stays loading; a real block settles as blocked', async () => {
  const hook = await read('src/hooks/useAttentionFeed.ts');
  assert.match(hook, /if \(deviceRegistrationBlock\) return 'blocked';/);
  assert.match(hook, /if \(deviceRegistrationPending\) return 'disabled';/);
  // Only a settled snapshot may emit an impression.
  assert.match(hook, /if \(!feed\.isSettled \|\| !feed\.serverState\) return;/);
  // Neither can produce the clean claim.
  assert.match(hook, /serverPhase === 'success' &&\s*\n\s*coverage === 'complete'/);
});

test('an impression waits for BOTH sources, so it cannot double on a race', async () => {
  // Codex round 2: gating on the server alone emitted once with the loading
  // local fingerprint and again when the local read landed, so whether
  // impressions doubled depended on network-vs-storage timing.
  const hook = await read('src/hooks/useAttentionFeed.ts');
  assert.match(hook, /if \(!feed\.localSettled\) return;/);
  const effect = hook.slice(hook.indexOf('export function useAttentionImpression'));
  assert.ok(
    effect.indexOf('if (!feed.localSettled) return;') <
      effect.indexOf('lastFingerprintRef.current = feed.fingerprint'),
    'the local gate runs before the fingerprint is recorded'
  );
  assert.match(effect, /feed\.localSettled,\s*\n\s*\]\);/);
  // An explicitly settled UNKNOWN local read still counts as settled, so a
  // Keystore failure cannot suppress impressions forever.
  assert.match(hook, /localSettled: localSummary !== null \|\| localQuery\.isError,/);
});

test('the clean claim requires all six conditions', async () => {
  const hook = await read('src/hooks/useAttentionFeed.ts');
  const cleanBlock = hook.slice(hook.indexOf('const isClean ='), hook.indexOf('const fingerprint'));
  for (const condition of [
    "serverPhase === 'success'",
    "coverage === 'complete'",
    'derivation.classificationComplete',
    'derivation.items.length === 0',
    'localComplete',
    'draftCount ?? 0) === 0',
    'stashSessionCount ?? 0) === 0',
  ]) {
    assert.ok(cleanBlock.includes(condition), condition);
  }
});

test('undefined data is never translated into a clean state', async () => {
  const hook = await read('src/hooks/useAttentionFeed.ts');
  assert.match(hook, /if \(serverQuery\.isError\) return serverQuery\.data \? 'stale_error' : 'error';/);
  assert.match(hook, /if \(!serverQuery\.data\) return 'loading';/);
});

test('polling and the clock tick pause in the background and never run faster than a minute', async () => {
  const hook = await read('src/hooks/useAttentionFeed.ts');
  assert.match(hook, /ATTENTION_POLL_INTERVAL_MS = 60_000/);
  assert.match(hook, /ATTENTION_TICK_INTERVAL_MS = 60_000/);
  assert.match(hook, /if \(!focused \|\| !isAppActive\) return false;/);
  assert.match(hook, /hasPollableAttentionRow\(rows\) \? ATTENTION_POLL_INTERVAL_MS : false/);
  assert.match(hook, /const tickNeeded = focused && isAppActive && hasPendingTimingBoundary\(rows, nowMs\)/);
  assert.match(hook, /return \(\) => clearInterval\(timer\)/);
});

test('a cold offline launch cannot use a hydrated NORMAL recordings cache as attention proof', async () => {
  const persistence = await read('src/lib/queryPersistence.ts');
  // Attention never reaches disk, so there is nothing to hydrate...
  assert.match(persistence, /root === 'recordings' && sub === 'attention'/);
  const hook = await read('src/hooks/useAttentionFeed.ts');
  // ...and the phase derives ONLY from this query's own data.
  assert.match(hook, /serverQuery\.data/);
  assert.doesNotMatch(hook, /\['recordings', 'recent'\]/);
});

test('Home hides the section only for a settled, coverage-complete, clean feed', async () => {
  const section = await read('src/components/AttentionFeedSection.tsx');
  const fn = section.slice(
    section.indexOf('export function homeAttentionHasContent'),
    section.indexOf('interface AttentionFeedSectionProps')
  );
  assert.match(fn, /if \(feed\.items\.length > 0\) return true;/);
  assert.match(fn, /if \(attentionStateNotices\(feed\)\.length > 0\) return true;/);
  // Codex P2: an UNSETTLED feed has checked nothing, so hiding the block would
  // present "not looked yet" as "nothing to do" on an otherwise normal Home.
  // BOTH sources count — the server page routinely settles before the slower
  // SecureStore/native local read (Codex round 4).
  assert.match(fn, /if \(!feed\.isSettled \|\| !feed\.localSettled\) return true;/);
  assert.match(
    section,
    /homeAttentionIsChecking\(feed: UseAttentionFeedResult\): boolean \{\s*\n\s*return \(!feed\.isSettled \|\| !feed\.localSettled\) && feed\.items\.length === 0;/
  );
  // A truncated / unknown-coverage page still shows the section: an absent
  // "Needs Attention" block would itself read as all-clear.
  assert.match(fn, /return feed\.coverage !== 'complete';/);
  // …and while visible-but-unsettled it renders a checking line, not a verdict.
  assert.match(section, /export function homeAttentionIsChecking/);
  assert.match(section, /homeAttentionIsChecking\(feed\) \?/);
  assert.match(section, /ATTENTION_FEED_COPY\.loading/);
});

test('a pagination total smaller than the returned page is malformed', async () => {
  // Codex P2: rows and pagination were validated independently, so five rows
  // reporting `total: 0` passed and attentionCoverage() called it COMPLETE —
  // letting the surface make its one positive all-clear claim off a
  // self-contradictory proof.
  const row = (id) => ({
    id,
    userId: 'aaaaaaaa-0000-4000-8000-000000000001',
    status: 'completed',
    patientName: 'Bella',
    clientName: null,
    species: null,
    breed: null,
    appointmentType: null,
    qualityWarnings: [],
    aiExtractedMetadata: null,
    submittedAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
  });
  const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  assert.throws(
    () =>
      FEED.parseAttentionEnvelope({
        data: ids.map(row),
        pagination: { page: 1, limit: 100, total: 0, totalPages: 0 },
      }),
    (error) => error.code === 'ATTENTION_RESPONSE_MALFORMED'
  );

  // A consistent envelope still parses, and equal total/length is complete.
  const ok = FEED.parseAttentionEnvelope({
    data: ids.map(row),
    pagination: { page: 1, limit: 100, total: 2, totalPages: 1 },
  });
  assert.equal(ok.data.length, 2);
  assert.equal(FEED.attentionCoverage(ok), 'complete');
});

test('the surface copy is qualified: no "View all", dynamic M, feed-scoped clean claim', async () => {
  const strings = await read('src/constants/strings.ts');
  assert.match(strings, /viewRecent: 'View recent attention'/);
  assert.match(strings, /most recently updated practice recordings checked/);
  assert.match(strings, /clean: 'No supported items need attention right now'/);

  const stripComments = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const section = await read('src/components/AttentionFeedSection.tsx');
  const screen = await read('app/(app)/(tabs)/recordings/attention.tsx');
  for (const [label, source] of [['section', section], ['screen', screen]]) {
    assert.ok(!/View all/i.test(stripComments(source)), `${label} must never say "View all"`);
  }
  // The qualifier uses the ACTUAL returned page length, never a hardcoded 100.
  assert.match(section, /ATTENTION_FEED_COPY\.truncatedSummary\(feed\.serverItems\.length, feed\.checkedCount\)/);
});
