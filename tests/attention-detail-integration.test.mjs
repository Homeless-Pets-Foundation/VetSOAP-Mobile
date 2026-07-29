// Attention Feed — recording-detail integration (verification section 5).
// Functional assertions over the shared pure predicates plus structural fences
// on the screen, because the destructive/permission paths cannot be rendered
// headlessly.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { loadTsModule } from './helpers/loadTs.mjs';

const root = new URL('../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));

const OBS = await loadTsModule('src/lib/recordFirstObservability.ts');
const FEED = await loadTsModule('src/lib/attentionFeed.ts');

const DETAIL = await read('app/(app)/(tabs)/recordings/[id].tsx');
const CARD = await read('src/components/MetadataReviewCard.tsx');
const SECTION = await read('src/components/AttentionFeedSection.tsx');

function rec(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'aaaaaaaa-0000-4000-8000-000000000003',
    status: 'completed',
    patientName: 'Bella',
    clientName: null,
    species: null,
    breed: null,
    appointmentType: null,
    qualityWarnings: [],
    aiExtractedMetadata: null,
    submittedAt: '2026-07-29T11:00:00.000Z',
    updatedAt: '2026-07-29T11:00:00.000Z',
    ...overrides,
  };
}

// ─── Review mode for the review:'none' cohort ──────────────────────────────

test("review:'none' with a low-confidence suggestion opens REVIEW mode", () => {
  const recording = rec({
    aiExtractedMetadata: {
      review: 'none',
      appliedFields: [],
      fields: { breed: { value: 'Golden Retriever' } },
      dropReasons: [{ field: 'breed', reason: 'low_confidence' }],
    },
  });
  assert.equal(OBS.hasUnresolvedAiMetadataAttention(recording), true);
  // The screen drives the review card from the SHARED predicate, not the
  // incomplete `needsMetadataReview` flag.
  assert.match(DETAIL, /hasUnresolvedAiMetadataAttention\(recording\)/);
  assert.doesNotMatch(DETAIL, /Boolean\(recording\.needsMetadataReview\) \|\| metadataReviewState === 'unconfirmed'/);
});

test('confirmed metadata does not reappear after a refetch, even though drops persist', () => {
  const confirmed = rec({
    aiExtractedMetadata: {
      review: 'confirmed',
      appliedFields: ['patientName'],
      dropReasons: [{ field: 'breed', reason: 'low_confidence' }],
    },
  });
  assert.equal(OBS.hasUnresolvedAiMetadataAttention(confirmed), false);
  const derived = FEED.deriveRecordingAttention([confirmed], { id: confirmed.userId, role: 'owner' }, {
    nowMs: Date.parse('2026-07-29T12:00:00.000Z'),
    recordFirstEnabled: true,
  });
  assert.deepEqual(plain(derived.items), []);
});

test('the record-first capability gates ONLY the ambiguous null-metadata add state', () => {
  assert.match(
    DETAIL,
    /const showAddMetadata =\s*\n\s*recordingPermissions\.canEdit &&\s*\n\s*recordFirstEnabled/
  );
  assert.match(
    DETAIL,
    /const showEditMetadata =\s*\n\s*recordingPermissions\.canEdit &&\s*\n\s*recordFirstEnabled/
  );
  // ...but the unresolved review path does not consult it.
  const reviewBlock = DETAIL.slice(
    DETAIL.indexOf('const showMetadataReview ='),
    DETAIL.indexOf('const showAddMetadata =')
  );
  assert.ok(!reviewBlock.includes('recordFirstEnabled'));
  assert.ok(reviewBlock.includes('recordingPermissions.canEdit'));
});

// ─── Whole-review semantics ────────────────────────────────────────────────

test('the card exposes the COMPLETE unresolved reason set before either terminal action', () => {
  assert.match(CARD, /metadataAttentionReasons\(recording, \{ recordFirstEnabled \}\)/);
  assert.match(CARD, /reasonRows\.map\(\(reason\) => \(/);
  assert.match(CARD, /METADATA_REVIEW_COPY\.reasonsTitle/);
  // Remaining suggestions stay visible inside the edit sheet too.
  const sheet = CARD.slice(CARD.indexOf('<Sheet'));
  assert.match(sheet, /suggestions\.map\(/);
});

test('the terminal action is explicit; an ordinary edit never claims resolution', () => {
  assert.match(CARD, /METADATA_REVIEW_COPY\.saveAndFinish/);
  assert.match(CARD, /if \(opts\.includeReview\) payload\.review = 'confirmed';/);
  assert.match(CARD, /includeReview: canFinishReview/);
  assert.match(CARD, /const canFinishReview = mode === 'review' && hasMetadataObject && !resolutionBlocked;/);
});

test('a null aiExtractedMetadata never sends the server-ineffective review key', () => {
  // canFinishReview requires hasMetadataObject, which is signals.hasMetadataObject.
  assert.match(CARD, /const hasMetadataObject = signals\.hasMetadataObject;/);
  const signals = OBS.computeMetadataAttentionSignals(rec({ aiExtractedMetadata: null }));
  assert.equal(signals.hasMetadataObject, false);
});

test('Keep current dismisses only a real metadata object and never hides missing details', () => {
  assert.match(CARD, /METADATA_REVIEW_COPY\.keepCurrent/);
  assert.match(
    CARD,
    /const canDismissReview =\s*\n\s*mode === 'review' && hasMetadataObject && !signals\.missingDetails && !!onDismiss;/
  );
  assert.match(DETAIL, /payload: \{ review: 'dismissed' \}/);

  const blankMissing = rec({
    patientName: '',
    aiExtractedMetadata: { review: 'unconfirmed', appliedFields: [] },
  });
  assert.equal(OBS.computeMetadataAttentionSignals(blankMissing).missingDetails, true);
});

test('missing metadata cannot claim resolution until the patient name is filled', () => {
  assert.match(CARD, /const resolutionBlocked = signals\.missingDetails && !form\.patientName\.trim\(\);/);
  assert.match(CARD, /disabled=\{!hasAnyFormValue \|\| resolutionBlocked\}/);
  assert.match(CARD, /METADATA_REVIEW_COPY\.missingPatientNameHint/);
});

test('suggestions are opt-in — tapping fills the form and opens the sheet, never auto-saves', () => {
  assert.match(CARD, /const applySuggestion = \(field: RecordingMetadataField, value: string\) => \{/);
  assert.match(CARD, /setSheetOpen\(true\);/);
  const applyBlock = CARD.slice(CARD.indexOf('const applySuggestion'), CARD.indexOf('const handleSave'));
  assert.ok(!applyBlock.includes('onSave('), 'a suggestion tap must not save');
});

// ─── Resolution analytics ──────────────────────────────────────────────────

test('ai_metadata_review_resolved fires only on a REAL pre-mutation resolution', () => {
  assert.match(DETAIL, /wasUnresolvedBefore: !!recording && hasUnresolvedAiMetadataAttention\(recording\)/);
  assert.match(DETAIL, /const stillUnresolved = updatedRecording\s*\n\s*\? hasUnresolvedAiMetadataAttention\(updatedRecording\)/);
  assert.match(DETAIL, /if \(vars\.wasUnresolvedBefore && !stillUnresolved\) \{/);
});

test('the resolution event carries bounded, PHI-free codes and a validated source', () => {
  assert.match(DETAIL, /source: cameFromAttention \? 'attention_feed' : 'recording_detail'/);
  assert.match(DETAIL, /const cameFromAttention = from === 'attention';/);
  assert.match(DETAIL, /changed_fields: vars\.changedFields\.join\(','\)/);
  assert.match(DETAIL, /attention_reason_codes: vars\.reasonCodes/);
  assert.match(DETAIL, /MAX_REPORTED_REASON_CODES = 12/);
  // The reason encoding is `field:code` — never a value.
  assert.match(DETAIL, /reason\.field \? `\$\{reason\.field\}:\$\{code\}` : code/);
});

test('the analytics catalog forbids values on the resolution + feed events', async () => {
  const analytics = await read('src/lib/analytics.ts');
  assert.match(analytics, /attention_feed_shown/);
  assert.match(analytics, /attention_feed_item_opened/);
  assert.match(analytics, /source: AiMetadataResolutionSource/);
  assert.match(analytics, /changed_fields: string/);
  assert.match(analytics, /attention_reason_codes: string/);
  // No free-form clinical text anywhere on the new events.
  const feedEvents = analytics.slice(
    analytics.indexOf("name: 'attention_feed_shown'"),
    analytics.indexOf('// Account surface')
  );
  for (const banned of ['patientName', 'clientName', 'warning', 'message', 'error_message']) {
    assert.ok(!feedEvents.includes(banned), banned);
  }
});

// ─── Focus routing ─────────────────────────────────────────────────────────

test('the focus parameter is allowlisted and cannot bypass a permission gate', () => {
  assert.equal(FEED.parseAttentionFocus('metadata'), 'metadata');
  assert.equal(FEED.parseAttentionFocus('delete'), null);
  assert.match(DETAIL, /const requestedFocus = parseAttentionFocus\(focus\);/);
  // `focus` only chooses a scroll offset — the cards are still gated by canEdit
  // and the role checks; the parameter never appears in a visibility condition.
  const visibilityBlock = DETAIL.slice(
    DETAIL.indexOf('const showMetadataReview ='),
    DETAIL.indexOf('const renderInfoField')
  );
  assert.ok(!visibilityBlock.includes('requestedFocus'));
  assert.match(DETAIL, /scrollRef\.current\?\.scrollTo\(\{ y: Math\.max\(0, offset - 12\)/);
});

test('the attention screen lives INSIDE the recordings tab stack', async () => {
  // Structural, not cosmetic: while the screen sat at `app/(app)/attention.tsx`
  // — outside the `(tabs)` group — opening a row pushed the detail into the
  // recordings tab with no list beneath it. `back()` then unwound to the tab
  // root and the Recordings tab was permanently stranded on that detail, with
  // its list unreachable even by re-tapping the tab (verified on an Android
  // emulator). Same-stack means detail → attention → list pops naturally.
  const { access } = await import('node:fs/promises');
  await access(new URL('../app/(app)/(tabs)/recordings/attention.tsx', import.meta.url));
  await assert.rejects(() => access(new URL('../app/(app)/attention.tsx', import.meta.url)));

  const appLayout = await read('app/(app)/_layout.tsx');
  assert.doesNotMatch(appLayout, /Stack\.Screen name="attention"/);

  for (const file of [
    'app/(app)/(tabs)/recordings/index.tsx',
    'app/(app)/(tabs)/recordings/[id].tsx',
    'src/components/AttentionFeedSection.tsx',
  ]) {
    const source = await read(file);
    assert.doesNotMatch(source, /'\/attention' as never/, `${file} must not use the root route`);
  }
});

test('a feed entry routes back deterministically, never through root history', async () => {
  // `router.back()` follows the ROOT navigator history, so a cross-tab entry
  // undoes the TAB SWITCH instead of popping the screen — the exact mechanism
  // that stranded the Recordings tab. Both back affordances name the route.
  const goBackBody = DETAIL.slice(
    DETAIL.indexOf('const goBack = useCallback('),
    DETAIL.indexOf('// Android hardware back must take the SAME route')
  );
  assert.match(goBackBody, /if \(cameFromAttention\) \{\s*\n\s*router\.replace\('\/recordings\/attention' as never\);/);
  assert.ok(
    goBackBody.indexOf("router.replace('/recordings/attention' as never)") <
      goBackBody.indexOf('router.canGoBack()'),
    'the feed route is chosen BEFORE any history check'
  );

  const detailHardwareBack = DETAIL.slice(
    DETAIL.indexOf('// Android hardware back must take the SAME route'),
    DETAIL.indexOf('const startNewRecording')
  );
  assert.match(detailHardwareBack, /if \(!cameFromAttention\) return;/);
  assert.match(detailHardwareBack, /router\.replace\('\/recordings\/attention' as never\)/);
  assert.match(detailHardwareBack, /return true;/);
  assert.match(detailHardwareBack, /subscription\.remove\(\)/);

  // The feed screen itself must pop to its stack parent for the same reason.
  const screen = await read('app/(app)/(tabs)/recordings/attention.tsx');
  assert.match(screen, /const goBack = useCallback\(\(\) => \{\s*\n\s*router\.replace\('\/recordings'\);/);
  assert.doesNotMatch(screen, /router\.canGoBack\(\)/);
  assert.match(screen, /BackHandler\.addEventListener\('hardwareBackPress'/);
});

test('a read-only viewer still sees WHAT the feed flagged on the destination', () => {
  // Practice-wide rows navigate here; without this the tap is a dead end.
  //
  // Codex P2: gating on `hasUnresolvedAiMetadataAttention` silently excluded the
  // `aiExtractedMetadata === null` cohort, which the feed DOES surface as
  // `metadata_missing`. Deriving the notice from the same reason builder the
  // feed uses makes the two agree by construction.
  assert.match(
    DETAIL,
    /const readOnlyMetadataReasons =\s*\n\s*!recordingPermissions\.canEdit && recording\.status === 'completed'\s*\n\s*\? metadataAttentionReasons\(recording, \{ recordFirstEnabled \}\)/
  );
  assert.match(DETAIL, /const showMetadataReadOnlyNotice = readOnlyMetadataReasons\.length > 0;/);
  assert.match(DETAIL, /\{ATTENTION_FEED_COPY\.readOnlyNote\}/);

  // Functional proof: the null-extraction cohort the feed emits is now covered.
  const nullExtraction = rec({
    patientName: '',
    status: 'completed',
    aiExtractedMetadata: null,
  });
  const feedReasons = FEED.metadataAttentionReasons(nullExtraction, { recordFirstEnabled: true });
  assert.ok(feedReasons.length > 0, 'the feed flags this cohort…');
  assert.equal(plain(feedReasons)[0].code, 'metadata_missing');
  assert.equal(
    OBS.hasUnresolvedAiMetadataAttention(nullExtraction),
    false,
    '…while the old predicate did not, which is why the notice must not use it'
  );
  // Informational only — it must not introduce a mutation affordance.
  const noticeBlock = DETAIL.slice(
    DETAIL.indexOf('{showMetadataReadOnlyNotice && ('),
    DETAIL.indexOf('{/* Patient Info */}')
  );
  assert.ok(noticeBlock.length > 0, 'the read-only notice block renders');
  assert.doesNotMatch(noticeBlock, /onPress|MetadataReviewCard|Button/);
});

test('the feed links to detail with from=attention and a validated focus', () => {
  assert.match(SECTION, /\?from=attention&focus=\$\{destination\.focus\}/);
  assert.match(SECTION, /\?from=attention/);
});

// ─── Processing actionability ──────────────────────────────────────────────

test('retry controls are role-gated to owner/admin/veterinarian, not authorship', () => {
  assert.match(DETAIL, /const canRetryProcessing = canRecordAppointments\(user\?\.role\);/);
  const retryUses = DETAIL.match(/canRetryProcessing/g) ?? [];
  assert.ok(retryUses.length >= 4, 'every retry + start-new control is gated');
  assert.match(DETAIL, /\{retryPresentation === 'retry' && canRetryProcessing && \(/);
});

test('stale processing uses ROW AGE, not "30 minutes since this screen began polling"', () => {
  assert.match(DETAIL, /const processingStaleness = getProcessingStaleness\(\{/);
  assert.match(DETAIL, /audioAvailability: recording\?\.audioFileUrl \? 'known_present' : 'known_absent'/);
  assert.match(DETAIL, /const isPollingStale = processingStaleness === 'stale';/);
  assert.doesNotMatch(
    DETAIL,
    /const isPollingStale =\s*\n\s*!!pollingStartedAtRef\.current/
  );
});

test('the feed promises only a neutral Review/Open CTA for processing rows', () => {
  const strings = read('src/constants/strings.ts');
  return strings.then((source) => {
    assert.match(source, /ctaOpenRecording: 'Open recording'/);
    // No "Retry" CTA is ever produced by the pure builder — the list omits
    // audioFileUrl, so only detail can choose Retry vs Audio unavailable.
    const feed = FEED.deriveRecordingAttention(
      [rec({ status: 'failed' })],
      { id: rec().userId, role: 'veterinarian' },
      { nowMs: Date.parse('2026-07-29T12:00:00.000Z'), recordFirstEnabled: true }
    );
    assert.equal(feed.items[0].ctaLabel, 'Open recording');
  });
});

// ─── Audio-unavailable deletion guard ──────────────────────────────────────

test('the destructive delete is reachable ONLY after a proven no-anchor result', () => {
  assert.match(DETAIL, /findLocalRecoveryAnchor\(user, id\)/);
  assert.match(
    DETAIL,
    /\{localAnchor\?\.kind === 'none' && recordingPermissions\.canDelete \? \(/
  );
  // Loading and ambiguous states render guidance, never the delete button.
  assert.match(DETAIL, /\{!localAnchor \|\| localAnchor\.kind === 'unknown' \? \(/);
  assert.match(DETAIL, /setLocalAnchor\(\{ kind: 'unknown' \}\)/);
  assert.match(DETAIL, /DELETE_RECORDING_COPY\.unknownLocalState/);
});

test('a proven on-device anchor routes to its real recovery surface', () => {
  assert.match(DETAIL, /case 'draft':\s*\n\s*router\.navigate\(`\/record\?draftSlotId=\$\{localAnchor\.draftSlotId\}`/);
  assert.match(DETAIL, /case 'saved_session':/);
  assert.match(DETAIL, /router\.push\('\/durable-recovery' as never\)/);
  assert.match(DETAIL, /router\.push\('\/recording-recovery' as never\)/);
});

test('the destructive confirmation states the cascade and the cross-device limit', async () => {
  const strings = await read('src/constants/strings.ts');
  assert.match(strings, /permanently deletes the server recording and any SOAP note or tasks/);
  assert.match(strings, /disrupt recovering this visit from another device/);
  assert.match(strings, /colleagueSuffix/);
  assert.match(DETAIL, /const isAuthor = !!user\?\.id && recording\?\.userId === user\.id;/);
  assert.match(DETAIL, /DELETE_RECORDING_COPY\.colleagueSuffix/);
});

test('a terminal non-draft delete purges every cascaded cache before navigating', () => {
  const successBlock = DETAIL.slice(
    DETAIL.indexOf('const deleteMutation = useMutation'),
    DETAIL.indexOf('const confirmDeleteDraft')
  );
  assert.ok(successBlock.indexOf('purgeDeletedRecordingCaches') < successBlock.indexOf("router.navigate('/recordings')"));
  assert.match(successBlock, /patientId: recording\?\.patientId \?\? null/);
});

// ─── Row dates ─────────────────────────────────────────────────────────────

const DISPLAY = await loadTsModule('src/lib/recordingDisplay.ts');

test('formatShortDate never hands an invalid Date to Intl and adds the year only when it differs', () => {
  const now = Date.parse('2026-07-29T12:00:00.000Z');

  // Rule 11: no usable timestamp yields '', never "Invalid Date".
  for (const bad of [null, undefined, NaN, Infinity, -Infinity, '2026-07-29']) {
    assert.equal(DISPLAY.formatShortDate(bad, now), '', `rejected: ${String(bad)}`);
  }

  // Same year → compact; a different year must say so, or a year-old row reads
  // as today.
  const sameYear = DISPLAY.formatShortDate(Date.parse('2026-07-29T15:00:00.000Z'), now);
  assert.match(sameYear, /^Jul 2\d$/);
  assert.doesNotMatch(sameYear, /2026/);
  assert.match(DISPLAY.formatShortDate(Date.parse('2025-07-29T15:00:00.000Z'), now), /2025/);

  // An unusable reference clock must not crash or silently claim "this year".
  assert.match(DISPLAY.formatShortDate(Date.parse('2026-07-29T15:00:00.000Z'), NaN), /2026/);
});

test('a feed row is dated by visit date, falling back to last-updated', () => {
  // Same precedence the feed already sorts by, so the visible date matches the
  // ordering rather than contradicting it.
  assert.match(SECTION, /formatShortDate\(item\.submittedAtMs \?\? item\.updatedAtMs, Date\.now\(\)\)/);
  assert.match(SECTION, /import \{ formatShortDate \} from '\.\.\/lib\/recordingDisplay'/);

  // Rendered in the `badge` slot, NOT appended to the single-line `meta` that
  // already carries "+N more issues · CTA" and ellipsizes.
  assert.match(SECTION, /badge=\{/);
  const metaFn = SECTION.slice(
    SECTION.indexOf('function metaLineFor'),
    SECTION.indexOf('interface AttentionItemRowProps')
  );
  assert.doesNotMatch(metaFn, /formatShortDate|submittedAtMs|updatedAtMs/);

  // Android under-measures short Text in a flex-row and clips the last glyph.
  const badgeBlock = SECTION.slice(SECTION.indexOf('badge={'), SECTION.indexOf('showChevron'));
  assert.match(badgeBlock, /flexShrink: 0/);

  // Screen readers get the date too.
  assert.match(SECTION, /\$\{item\.accessibilityLabel\}\. \$\{dateLabel\}/);
});

test('device-local summary rows carry no timestamps, so they render no date', () => {
  const localItems = FEED.buildLocalAttentionItems(
    { draftCount: 2, stashSessionCount: 1, draftsKnown: true, stashesKnown: true },
    { id: 'aaaaaaaa-0000-4000-8000-000000000003', role: 'veterinarian' }
  );
  assert.equal(localItems.length, 2);
  for (const item of localItems) {
    assert.equal(item.submittedAtMs, null);
    assert.equal(item.updatedAtMs, null);
    // Which is exactly what the row's formatter turns into "no badge".
    assert.equal(
      DISPLAY.formatShortDate(item.submittedAtMs ?? item.updatedAtMs, Date.now()),
      ''
    );
  }
});
