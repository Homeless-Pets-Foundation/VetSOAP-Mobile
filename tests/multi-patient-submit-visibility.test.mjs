import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('dirty server draft metadata is applied through strict preparation and confirmation', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const api = await read('src/api/recordings.ts');
  const retry = await read('src/lib/retryableCleanup.ts');
  const uploadRetry = await read('src/api/uploadRetry.ts');
  const mismatch = await read('src/api/metadataMismatch.ts');

  assert.match(uploadRetry, /\| 'patch_draft'/);
  // patch_draft is no longer blanket-recoverable. The throw site decides, so a
  // post-confirm mismatch (which dead-ends the user on a submit that actually
  // succeeded) pages, while idempotent replays keep PR #92's warning.
  assert.match(
    record,
    /if \(getUploadPhase\(error\) === 'patch_draft'\) return getUploadRecoverableHint\(error\) \?\? true;/
  );
  assert.doesNotMatch(record, /draftMetadataSyncBlockedError/);

  assert.match(record, /metadataDirty: !!slot\.draftMetadataDirty/g);
  assert.match(record, /onRecordingPrepared/);
  assert.match(record, /dispatch\(\{ type: 'CLEAR_DRAFT_DIRTY', slotId: slot\.id \}\)/);

  assert.match(api, /function completeUploadMetadata/);
  assert.match(api, /metadata: PendingConfirmMetadata/);
  assert.match(api, /metadata,\s*files/);
  assert.match(api, /postConfirm\(hint\.recordingId, hint, metadata, metadataMatchOptions\)/);
  // The comparison itself now lives in ./metadataMismatch so it is executable
  // under the vm test loader; the enrichment escape hatch and the
  // absent-key/differing-value split must both survive the extraction.
  assert.match(mismatch, /export const SERVER_ENRICHABLE_BLANK_METADATA_FIELDS/);
  assert.match(mismatch, /allowServerEnrichedBlankFields/);
  assert.match(mismatch, /!\(key === 'pimsPatientId' && opts\.pimsPatientIdExplicitlyCleared\)/);
  assert.match(mismatch, /Object\.prototype\.hasOwnProperty\.call\(recordingData, key\)/);
  // Every assertion site must name its origin, so no patch_draft failure can
  // reach telemetry anonymously again.
  assert.match(api, /function assertRecordingMatchesMetadataPayload\([\s\S]*origin: MetadataAssertionOrigin/);
  assert.match(
    api,
    /assertRecordingMatchesMetadataPayload\(\s*value\.recording,\s*metadataAsPayload\(metadata\),\s*matchOptions,\s*'prepare_already_uploaded',/
  );
  assert.doesNotMatch(api, /isAlreadyConfirmedOrProcessing/);

  const syncDraft = record.slice(
    record.indexOf('const syncServerDraft = useCallback'),
    record.indexOf('// Schedule phase 2.')
  );
  assert.match(syncDraft, /if \(outcome === 'success'\) \{/);
  assert.match(syncDraft, /sync_server_draft_metadata_not_synced/);
  assert.match(syncDraft, /dispatch\(\{ type: 'MARK_DRAFT_METADATA_DIRTY', slotId \}\)/);
  assert.doesNotMatch(syncDraft, /outcome === 'success' \|\| outcome === 'transient_failure'/);
  assert.match(record, /preserveDirty: !!slot\.serverDraftId && slot\.draftMetadataDirty/);
  const session = await read('src/hooks/useMultiPatientSession.ts');
  const types = await read('src/types/multiPatient.ts');
  const draftStorage = await read('src/lib/draftStorage.ts');
  const recoveryVault = await read('src/lib/supportStaffRecoveryVault.ts');
  assert.match(types, /type: 'MARK_DRAFT_METADATA_DIRTY'; slotId: string/);
  assert.match(types, /preserveDirty\?: boolean/);
  assert.match(types, /pimsPatientIdExplicitlyCleared: boolean/);
  assert.match(session, /case 'MARK_DRAFT_METADATA_DIRTY':/);
  assert.match(session, /nextPimsPatientIdExplicitlyCleared/);
  assert.match(session, /draftMetadataDirty: !!slot\.serverDraftId && slot\.draftMetadataDirty/);
  assert.match(session, /draftMetadataDirty: preserveDirty/);
  assert.match(draftStorage, /pimsPatientIdExplicitlyCleared: isPimsPatientIdExplicitlyCleared/g);
  assert.match(retry, /transient_failure';\s*\/\/ retries exhausted — caller must keep local audio recoverable/);

  const stashTypes = await read('src/types/stash.ts');
  const stashAudio = await read('src/lib/stashAudioManager.ts');
  const useStash = await read('src/hooks/useStashedSessions.ts');
  assert.match(stashTypes, /draftMetadataDirty\?: boolean/);
  assert.match(stashTypes, /pimsPatientIdExplicitlyCleared\?: boolean/);
  assert.match(stashAudio, /draftMetadataDirty: !!slot\.serverDraftId && slot\.draftMetadataDirty/);
  assert.match(stashAudio, /pimsPatientIdExplicitlyCleared: isPimsPatientIdExplicitlyCleared/);
  assert.match(useStash, /draftMetadataDirty\?: boolean/);
  assert.match(useStash, /pimsPatientIdExplicitlyCleared\?: boolean/);
  assert.match(useStash, /pimsPatientIdExplicitlyCleared: isPimsPatientIdExplicitlyCleared/);
  assert.match(useStash, /draftMetadataDirty: !!slot\.serverDraftId && \(slot\.draftMetadataDirty === true \|\| slot\.draftMetadataDirty === undefined\)/);
  assert.match(recoveryVault, /pimsPatientIdExplicitlyCleared: isPimsPatientIdExplicitlyCleared/g);
  assert.match(record, /pimsPatientIdExplicitlyCleared: isPimsPatientIdExplicitlyCleared/g);
});

test('Submit All uses the same metadata gate as per-slot submit outside record-first', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const panel = await read('src/components/SubmitPanel.tsx');

  assert.match(record, /function slotHasRequiredSubmitFields\(slot: PatientSlot\): boolean/);
  assert.match(record, /const recordedSlotsNeedingDetails = recordFirstEnabled[\s\S]*!slotHasRequiredSubmitFields\(s\)/);
  assert.match(record, /Alert\.alert\(\s*'Add Required Details'/);
  assert.match(
    record,
    /await awaitScoped\(\(\) => draftStorage\.markDraftMetadataDirty\(slotId\)\)/,
  );
  assert.match(record, /draftMetadataDirty: draft\.draftMetadataDirty \|\| !!draft\.serverDraftId/);
  assert.match(record, /\(recordFirstEnabled \|\| slotHasRequiredSubmitFields\(s\)\) &&\s*s\.uploadStatus !== 'success'/);
  assert.match(record, /recordFirstEnabled=\{recordFirstEnabled\}/);

  assert.match(panel, /recordFirstEnabled\?: boolean/);
  assert.match(panel, /const canSubmitSlot = \(s: PatientSlot\) => recordFirstEnabled \|\| hasRequiredFields\(s\)/);
  assert.match(panel, /readyToUpload = slots\.filter\(\s*\(s\) => hasAudio\(s\) && canSubmitSlot\(s\)/);
  assert.match(panel, /needsDetails/);
  assert.match(panel, /const submitBlockedByMissingDetails = needsDetails > 0/);
  assert.match(panel, /readyToUpload === 0 && needsDetails === 0/);
  assert.match(panel, /disabled=\{isSubmitting \|\| hasActiveRecording \|\| submitBlockedByMissingDetails\}/);
  assert.match(panel, /Add Required Details/);
});

test('Submit All routes submitted ids and recordings list pins/highlights them', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const list = await read('app/(app)/(tabs)/recordings/index.tsx');
  const card = await read('src/components/RecordingCard.tsx');
  const api = await read('src/api/recordings.ts');

  assert.match(record, /const submittedRecordingIds: string\[\] = \[\]/);
  assert.match(record, /submittedRecordingIds\.push\(recordingId\)/);
  assert.match(record, /params: \{ submittedIds: submittedRecordingIds\.join\(','\) \}/);
  assert.match(record, /submit_all_completed/);

  assert.match(list, /useLocalSearchParams<\{ submittedIds\?: string \| string\[\] \}>/);
  assert.match(list, /const MAX_SUBMITTED_IDS = 10/);
  assert.match(list, /const UUID_REGEX = \/\^\[0-9a-f\]\{8\}/);
  assert.match(list, /function normalizeSubmittedIdsParam\(submittedIdsParam: string \| string\[\] \| undefined\): string\[\]/);
  assert.match(list, /if \(!UUID_REGEX\.test\(id\) \|\| seen\.has\(id\)\) continue/);
  assert.match(list, /if \(ids\.length >= MAX_SUBMITTED_IDS\) break/);
  assert.match(list, /const submittedIds = useMemo\(\(\) => normalizeSubmittedIdsParam\(submittedIdsParam\), \[submittedIdsParam\]\)/);
  assert.match(list, /function recordingMatchesStatusFilter\(recording: Recording, selectedStatusFilter: StatusFilterValue\): boolean/);
  assert.match(list, /function recordingMatchesSearch\(recording: Recording, searchQuery: string\): boolean/);
  // The unsupported `needs_review` filter is gone (Connect has no recording
  // review contract); Needs Attention is a navigation entry instead.
  assert.doesNotMatch(list, /needs_review/);
  assert.match(list, /ATTENTION_FEED_COPY\.sectionTitle/);
  assert.match(list, /recordingMatchesStatusFilter\(recording, selectedStatusFilter\)/);
  assert.match(list, /recordingMatchesSearch\(recording, debouncedSearch\)/);
  assert.match(list, /sortBy: 'submittedAt'/);
  assert.match(list, /sortRecordingsBySubmittedAt/);
  assert.match(list, /useQueries\(\{\s*queries: submittedIds\.map/);
  assert.match(list, /recordingsApi\.get\(id\)/);
  assert.match(list, /refetchOnMount: 'always' as const/);
  assert.match(list, /for \(const recording of recordings\)[\s\S]*for \(const query of submittedRecordingQueries\)/);
  // Detail results are a FALLBACK for ids the polled list doesn't contain —
  // the list refetches processing recordings every 10s while detail queries
  // fetch once on mount (Codex P2 round 7).
  assert.match(list, /for \(const query of submittedRecordingQueries\)[\s\S]*submittedIdSet\.has\(recording\.id\) && !map\.has\(recording\.id\)/);
  assert.match(list, /const pinSubmitted = \(items: Recording\[\]\): Recording\[\] =>/);
  assert.match(list, /\}, \[debouncedSearch, mergedDrafts, recordings, selectedStatusFilter, submittedIds, submittedIdSet, submittedRecordingsById\]\)/);
  assert.match(list, /highlighted=\{submittedIdSet\.has\(item\.id\)\}/);
  // WP9: the banner shows per-recording rows (patient name + live status)
  // instead of the constant "N of N submitted" + raw UUID list.
  assert.match(list, /SUBMITTED_BANNER_COPY\.title\(submittedIds\.length\)/);
  assert.match(list, /submittedRecordingsById\.get\(submittedId\)/);
  assert.match(list, /<StatusBadge status=\{submittedRecording\.status\} \/>/);
  assert.ok(!/IDs \{submittedIds\.map/.test(list), 'raw UUID list must not be shown to users');

  assert.match(card, /highlighted\?: boolean/);
  assert.match(card, /highlighted = false/);
  assert.match(card, /highlighted \? 'border-brand-500 bg-brand-50 dark:bg-surface-sunken' : ''/);
  assert.match(card, /prev\.highlighted === next\.highlighted/);

  const home = await read('app/(app)/(tabs)/index.tsx');
  assert.match(home, /sortBy: 'submittedAt'/);

  assert.match(api, /function shouldFallbackSubmittedAtSort\(error: unknown, params: ListRecordingsParams\): boolean/);
  assert.match(api, /error instanceof ApiError && error\.status === 400 && params\.sortBy === 'submittedAt'/);
  assert.match(api, /return await apiClient\.get\('\/api\/recordings', sanitized, \{ signal \}\)/);
  assert.match(api, /\.\.\.sanitized, sortBy: 'createdAt'/);
  // `signal` is a transport concern, never a query param — it must be stripped
  // off before the params object is built, on both the primary and the
  // submittedAt-fallback request.
  assert.match(api, /const \{ signal, \.\.\.queryParams \} = params;/);
  assert.match(api, /const sanitized = \{ \.\.\.queryParams \}/);
  assert.match(api, /\{ \.\.\.sanitized, sortBy: 'createdAt' \}, \{ signal \}/);
});

test('APK smoke script translates WSL APK paths before Windows adb install', async () => {
  const script = await read('scripts/verify-submit-visibility-apk.sh');

  assert.match(script, /INSTALL_APK_PATH="\$\{APK_PATH\}"/);
  assert.match(script, /\[\[ "\$\{ADB_BIN\}" == \*\.exe \]\]/);
  assert.match(script, /wslpath -w "\$\{APK_PATH\}"/);
  assert.match(script, /adb_cmd install -r "\$\{INSTALL_APK_PATH\}"/);
});

test('submit telemetry includes PHI-free diagnostic context', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const analytics = await read('src/lib/analytics.ts');
  const telemetry = await read('src/api/telemetry.ts');

  assert.match(analytics, /export type SubmitDiagnosticsProps = \{/);
  assert.match(analytics, /has_existing_server_draft: boolean/);
  assert.match(analytics, /confirm_used_atomic_metadata_update: boolean/);
  assert.match(analytics, /stale_draft_promotion_blocked: boolean/);
  assert.match(analytics, /client_last_name_present: boolean/);
  assert.match(record, /function slotSubmitDiagnostics\(/);
  assert.match(record, /species_present: \(slot\.formData\.species\?\.trim\(\)\.length \?\? 0\) > 0/);
  assert.match(record, /const willUseAtomicMetadataUpdate = !!slot\.serverDraftId && slot\.draftMetadataDirty/);
  assert.match(record, /\.\.\.baseSubmitDiagnostics/);
  assert.match(record, /phase === 'patch_draft'[\s\S]*staleDraftPromotionBlocked: true/);
  assert.match(record, /submitContext: failureSubmitDiagnostics/);
  assert.match(telemetry, /submitContext\?: SubmitDiagnosticsProps/);
  assert.doesNotMatch(record, /patient_name_present|client_name_value|breed_value|file_uri/);
});

test('recording deletes send explicit PHI-free delete reasons', async () => {
  const api = await read('src/api/recordings.ts');
  const client = await read('src/api/client.ts');
  const record = await read('app/(app)/(tabs)/record.tsx');
  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');
  const retry = await read('src/lib/retryableCleanup.ts');

  assert.match(client, /delete<T>\(path: string, body\?: unknown\)/);
  assert.match(api, /export type RecordingDeleteReason =/);
  assert.match(api, /opts\?\.reason \? \{ reason: opts\.reason \} : undefined/);
  assert.match(retry, /reasonOrAttempts: RecordingDeleteReason \| number = 'orphan_pending_confirm'/);
  assert.match(record, /reason: RecordingDeleteReason = 'orphan_pending_confirm'/);
  assert.match(record, /reason: RecordingDeleteReason = 'discard_session'/);
  assert.match(record, /deleteSlotDraft\(slot, 'remove_slot'\)/);
  assert.match(record, /reason: 'missing_audio_rerecord'/);
  assert.match(record, /reason: 'orphan_draft_cleanup'/);
  assert.doesNotMatch(record, /deleteRecordingWithRetry\(serverId, 'post_upload_local_cleanup'\)/);
  assert.match(record, /A racing create can therefore return the exact canonical/);
  assert.match(record, /reason: 'user_delete'/);
  assert.match(detail, /recordingsApi\.delete\(id, \{ reason: 'user_delete' \}\)/);
});

test('a metadata divergence never deletes local work, and identity tier holds the copy back', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');

  // The reconcile sink is passed at every upload call site, or a divergence on
  // that path is silently lost.
  assert.equal((record.match(/onMetadataDivergence,/g) ?? []).length, 4);

  // The post-upload cleanup is gated. An identity divergence means the server
  // row may describe a different visit, so the only local copy is retained
  // until a human settles it (CLAUDE.md rules 8 and 13: un-sent local work is
  // never auto-deleted).
  assert.match(
    record,
    /const holdLocalCopy =\s*\(metadataDivergence as MetadataDivergenceReport \| null\)\?\.tier === 'identity';/
  );
  assert.match(record, /if \(!holdLocalCopy\) \{[\s\S]*?draftStorage\.deleteDraft\(slot\.id\)/);

  // Durable captures have their own success path. The hold-back applies there
  // too — they are the recordings the durability work exists to protect.
  assert.match(
    record,
    /const holdDurableLocalCopy =\s*divergenceReport\?\.tier === 'identity' && localAudioAvailableForRestart;/
  );
  assert.match(record, /if \(!holdDurableLocalCopy\) \{[\s\S]*?purgeAfterUpload/);
  // ...but markUploaded must run REGARDLESS, or durable recovery would
  // re-offer an already-uploaded capture and create a duplicate server row.
  const durableBranch = record.slice(
    record.indexOf('if (durable && uid) {'),
    record.indexOf('if (!holdDurableLocalCopy) {')
  );
  assert.match(durableBranch, /durableRecorder\s*\.markUploaded\(/);

  // The typed conflict is caught and surfaced, and deletes nothing.
  assert.match(record, /if \(error instanceof RecordingMetadataConflictError\) \{/);

  // A divergence that no longer fails the submit must still reach telemetry,
  // or the fix converts loud false failures into silence.
  assert.match(record, /errorCode: METADATA_MISMATCH_ERROR_CODE,/);

  // Releasing the local copy must mirror the cleanup the divergence held back,
  // durable half included, or the manifest and its audio linger in recovery.
  const releaseBlock = record.slice(
    record.indexOf('const handleReleaseLocalCopy = useCallback'),
    record.indexOf('const handleResubmitAsNew = useCallback')
  );
  assert.match(releaseBlock, /durableRecorder\s*\.purgeAfterUpload\(/);
  assert.match(releaseBlock, /durableTombstone\.add\(durable\.recordingId\)/);
  assert.match(releaseBlock, /durableRecoveryStore\.remove\(durable\.recordingId\)/);

  // Every reconcile action is behind an explicit confirmation.
  assert.match(record, /METADATA_DIVERGENCE_COPY\.releaseLocalCopyConfirmTitle/);
  assert.match(record, /METADATA_DIVERGENCE_COPY\.resubmitAsNewConfirmTitle/);
});

test('the commit path proves identity by recording id, not by metadata equality', async () => {
  const api = await read('src/api/recordings.ts');

  // Metadata equality never protected the commit path: the recording id is in
  // the confirm URL and the server independently verifies key grammar, the
  // upload manifest, and an R2 HEAD. This is the strictly stronger check that
  // replaces it.
  assert.match(api, /function assertCommittedRecordingIdentity\(/);
  assert.match(api, /assertCommittedRecordingIdentity\(recordingId, confirmed, 'confirm'\);/);
  assert.match(api, /assertCommittedRecordingIdentity\(recordingId, recording, 'confirm_api'\);/);

  // Only the adopt sites — the local-deletion gates — still fail closed.
  assert.match(api, /if \(isAdoptMetadataOrigin\(origin\) && hasIdentityDivergence\(comparison\)\)/);

  // The server's own 409 must reach the same reconcile surface, or the retry
  // dead-ends on the server after the client guard is fixed.
  assert.match(api, /function typedMetadataConflict\(/);
  assert.match(api, /error\.code !== 'RECORDING_METADATA_CONFLICT'/);
  assert.equal((api.match(/typedMetadataConflict\(error, /g) ?? []).length, 2);
});

test('every durable success path honors the identity hold-back, not just the resume branch', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');

  // There are two durable success paths: the pending-confirm resume branch and
  // the fresh upload. Holding back only one leaves the reconcile card promising
  // a copy the other already purged.
  assert.match(
    record,
    /const holdDurableLocalCopy =\s*divergenceReport\?\.tier === 'identity' && localAudioAvailableForRestart;/
  );
  assert.match(
    record,
    /const holdIdentityCopy =\s*\(metadataDivergence as MetadataDivergenceReport \| null\)\?\.tier === 'identity';[\s\S]{0,3000}?const holdFreshDurableCopy = holdIdentityCopy;/
  );
  assert.match(record, /if \(!holdFreshDurableCopy\) \{[\s\S]*?purgeAfterUpload/);
});

test('an unresolved divergence keeps the session mounted so the card is reachable', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');

  // uploadSlot returns a recording id on a non-blocking divergence, and both
  // submit paths would otherwise reset and navigate away — discarding the card
  // before the vet sees why a local copy was retained.
  assert.equal((record.match(/const hasUnresolvedDivergence = sessionRef\.current\.slots\.some\(/g) ?? []).length, 2);
  assert.match(record, /if \(otherSlotsWithRecordings \|\| hasUnresolvedDivergence\) \{/);
  // Submit All must not fall into the failure branch: nothing failed.
  assert.match(record, /if \(allSuccess && hasUnresolvedDivergence\) \{/);
  assert.match(record, /\} else if \(allSuccess\) \{/);
});

test('a server-reported conflict is never rendered as a wrong-visit conflict', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const card = await read('src/components/PatientSlotCard.tsx');

  // A server 409 covers processing and descriptive mismatches too. Claiming
  // identity would offer "submit separately" on a template mismatch, creating
  // the duplicate this change exists to prevent.
  assert.match(
    record,
    /const conflictTier = error\.source === 'client_adopt_guard' \? 'identity' : 'unknown';[\s\S]{0,400}?tier: conflictTier,/
  );
  // The unknown tier gets the non-destructive affordance only, and only when
  // there is actually a recording to open.
  assert.match(
    card,
    /slot\.metadataDivergence\.tier === 'unknown' &&\s*slot\.metadataDivergence\.recordingId\.length > 0/
  );
});

test('releasing the local copy verifies the draft is gone before destroying evidence', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const releaseBlock = record.slice(
    record.indexOf('const handleReleaseLocalCopy = useCallback'),
    record.indexOf('const handleResubmitAsNew = useCallback')
  );

  // deleteDraft swallows its own storage failures, so only a read-back can tell
  // whether the metadata is actually gone. Purging audio while a stale draft
  // survives is the state an orphan sweep resolves by deleting the server row.
  assert.match(releaseBlock, /const confirmDraftGone = async \(\): Promise<boolean> => \{/);
  assert.match(releaseBlock, /let draftDeleted = await confirmDraftGone\(\);/);
  assert.match(releaseBlock, /if \(!draftDeleted\) draftDeleted = await confirmDraftGone\(\);/);
  // Tombstone before purge, and purge only on a verified delete.
  const tombstoneAt = releaseBlock.indexOf('durableTombstone');
  const purgeAt = releaseBlock.indexOf('purgeAfterUpload');
  assert.ok(tombstoneAt > -1 && purgeAt > -1 && tombstoneAt < purgeAt,
    'the tombstone must be persisted before the audio is purged');
  assert.match(releaseBlock, /if \(draftDeleted\) \{\s*purgeInFlight = true;\s*try \{\s*await durableRecorder/);

  // The slot must not be left in the adopt-path error state offering Retry
  // Upload against files that were just deleted.
  assert.match(releaseBlock, /setUploadStatus\(slot\.id, 'success', \{/);
  assert.match(releaseBlock, /type: 'REPLACE_ALL_SEGMENTS', slotId: slot\.id, segments: \[\]/);
});

test('the divergence notice renders outside the submit card, which excludes succeeded slots', async () => {
  const card = await read('src/components/PatientSlotCard.tsx');

  // showSubmitCard is false once the upload succeeds — and a commit-path
  // divergence lands exactly there (success + local copy held back). Nesting
  // the notice inside it left the vet with "Uploaded Successfully" and no way
  // to reach any of the three reconciliation actions.
  assert.match(
    card,
    /const showSubmitCard =[\s\S]{0,200}?slot\.uploadStatus !== 'success' &&\s*!identityReconciliationPending;/,
    'showSubmitCard must exclude succeeded slots AND pending identity reconciliation'
  );
  // Retry Upload would bypass the three explicit choices: uploadSlot() clears
  // metadataDivergence and re-runs the same adopt path.
  assert.match(
    card,
    /const identityReconciliationPending = slot\.metadataDivergence\?\.tier === 'identity';/
  );
  const submitCardAt = card.indexOf('{showSubmitCard && (');
  const noticeAt = card.indexOf('{slot.metadataDivergence && (');
  assert.ok(noticeAt > -1 && submitCardAt > -1);
  assert.ok(
    noticeAt < submitCardAt,
    'the divergence notice must render before/outside the submit card, not nested inside it'
  );
});

test('a successful divergence survives form edits, including cross-slot clientName edits', async () => {
  const session = await read('src/hooks/useMultiPatientSession.ts');

  // clientName runs applyFormUpdate for EVERY slot, so an unconditional clear
  // let editing one patient discard another patient's wrong-visit conflict —
  // the submit guard then stops retaining the session and no reconciliation
  // action remains. Edit-to-retry stays for a failed conflict.
  assert.match(
    session,
    /metadataDivergence:\s*slot\.uploadStatus === 'success' \? slot\.metadataDivergence : null,/
  );
  assert.doesNotMatch(
    session,
    /uploadRecovery: null,\s*\n\s*metadataDivergence: null,\s*\n\s*\}\);/,
    'applyFormUpdate must not clear metadataDivergence unconditionally'
  );
});

test('submitting separately converts a confirmed durable manifest instead of restarting it', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const engineKt = await read(
    'modules/captivet-durable-recorder/android/src/main/java/expo/modules/captivetdurablerecorder/DurableRecorderEngine.kt'
  );
  const engineSwift = await read('modules/captivet-durable-recorder/ios/DurableRecorderEngine.swift');

  // The native guard this works around. If either engine ever allows a
  // post-confirm rotation, revisit the conversion — do not delete it silently.
  assert.match(engineKt, /confirmed upload cannot be restarted/);
  assert.match(engineSwift, /confirmed upload cannot be restarted/);

  const convert = record.slice(
    record.indexOf('const persistPostConfirmSeparateSubmission = useCallback'),
    record.indexOf('const handleResubmitAsNew = useCallback')
  );
  assert.ok(convert.length > 0, 'the post-confirm conversion must exist');
  // Only a confirmed manifest takes this path; anything else keeps the
  // ordinary rotation, which is cheaper and leaves the native copy in place.
  assert.match(convert, /manifest\.state === 'uploaded' \|\| !!manifest\.confirmedUploadAt/);
  assert.match(convert, /if \(!confirmed\) return null;/);
  // Nothing destructive until a NON-EMPTY copy is verified on disk.
  // The copy is the COMPLETE-FRAME PREFIX, never the raw file: a recovered
  // audio.aac can end in a torn ADTS frame, the recovered-copy upload path
  // skips truncation, and this transaction purges the manifest that carries the
  // boundary needed to repair it.
  assert.match(convert, /const completeBytes = manifest\.audioFile\?\.completeFrameBytes \?\? 0;/);
  assert.match(convert, /if \(!\(completeBytes > 0\)\) return null;/);
  assert.doesNotMatch(convert, /safeCopyFile\(/);
  const copyAt = convert.indexOf('writeFilePrefix(sourceUri, copyUri, completeBytes)');
  const sizeAt = convert.indexOf('info.size !== completeBytes');
  const tombstoneAt = convert.indexOf('durableTombstone.add');
  const purgeAt = convert.indexOf('purgeAfterUpload');
  assert.ok(copyAt > -1 && sizeAt > copyAt, 'the copy must be size-verified');
  assert.ok(tombstoneAt > sizeAt, 'nothing may be destroyed before the copy is verified');
  assert.ok(purgeAt > tombstoneAt, 'the tombstone must be persisted before the purge');
  assert.ok(purgeAt > copyAt);
  assert.match(convert, /recoveredAudioUri: copyUri/);
  assert.match(convert, /type: 'SET_DURABLE_RECORDING'/);
  // The purge is the point of no return, so the pointer to the copy must be
  // persisted AND read back first: a crash in between would otherwise leave the
  // stored draft aimed at a manifest that no longer exists while the copy sits
  // unreferenced. The tombstone is required, not best-effort — without it a
  // later orphan sweep can delete the confirmed server row.
  const saveAt = convert.indexOf('draftStorage.saveDraft(converted)');
  const readBackAt = convert.indexOf('readBack?.durable?.recoveredAudioUri !== copyUri');
  const tombstonedAt = convert.indexOf('const tombstoned = await durableTombstone.add');
  assert.ok(saveAt > sizeAt, 'the draft pointer must be persisted after the copy is verified');
  assert.ok(readBackAt > saveAt, 'the persisted pointer must be read back');
  assert.ok(tombstonedAt > readBackAt && tombstonedAt < purgeAt);
  assert.match(convert, /if \(!tombstoned \|\| !scopeIsCurrent\(\)\) return null;/);
  // Every user-scoped write is fenced: a sign-out plus another sign-in while
  // the copy is in flight must not land this user's slot and audio URI in the
  // next user's namespace on a shared tablet.
  assert.match(convert, /const scopeIsCurrent = \(\) =>/);
  assert.ok(
    (convert.match(/if \(!scopeIsCurrent\(\)\)/g) ?? []).length >= 4,
    'the conversion must recheck auth scope around every storage mutation'
  );

  const resubmit = record.slice(
    record.indexOf('const handleResubmitAsNew = useCallback'),
    record.indexOf('const handleSubmitSingle = useCallback')
  );
  // Rule 24: the conversion runs inside markSubmitIntent and before the
  // restart's own watchdog exists, so a hung Keystore would freeze the whole
  // Record UI. It must be bounded, and the timeout must unwind the intent.
  assert.match(
    resubmit,
    /const conversion = persistPostConfirmSeparateSubmission\([\s\S]{0,200}?withPromiseTimeout\(\s*conversion,\s*POST_CONFIRM_CONVERSION_TIMEOUT_MS/
  );
  assert.match(resubmit, /persistControlledUploadRestart\(converted \?\? slot\)/);
  // A failed separate submission must say so — silence reads as "done".
  assert.match(resubmit, /METADATA_DIVERGENCE_COPY\.resubmitAsNewFailedTitle/);
});

test('destructive cleanup requires PROVEN draft absence, never a lenient null', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const drafts = await read('src/lib/draftStorage.ts');

  // getDraft collapses a Keystore/chunk-read failure to null, which is
  // indistinguishable from deletion. Every site that purges durable audio or
  // deletes segments on the strength of that answer must use the strict read.
  assert.match(drafts, /async draftMetadataExistsStrict\(slotId: string\): Promise<StrictExistence>/);
  assert.match(drafts, /if \(!userId\) return 'unknown';/);
  assert.match(drafts, /return legacyRaw === null \? 'missing' : 'present';/);
  assert.match(drafts, /return \(await draftMetaExistence\(userId, slotId\)\) === 'missing';/);

  assert.doesNotMatch(
    record,
    /draftStorage\.getDraft\(slot\.id\)\.catch\(\(\) => null\)\) === null/,
    'no destructive path may treat a lenient getDraft null as proof of deletion'
  );
  assert.equal(
    (record.match(/draftMetadataExistsStrict\(slot\.id\)/g) ?? []).length,
    3,
    'all three confirmDraftGone sites must use the strict read'
  );
});

test('every divergence that can hold the session open carries an action', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const card = await read('src/components/PatientSlotCard.tsx');

  // Blocking completion on a notice with no action stranded the vet on the
  // Record screen; not blocking at all navigated away before it could be read.
  // So the informational tiers get an explicit acknowledgement, and the guard
  // blocks until some action is taken.
  assert.match(
    card,
    /\(slot\.metadataDivergence\.tier === 'processing' \|\|\s*slot\.metadataDivergence\.tier === 'descriptive' \|\|\s*slot\.metadataDivergence\.tier === 'unknown'\) && \(/
  );
  assert.match(card, /onDismissDivergence\?\.\(slot\.id\)/);
  assert.match(record, /onDismissDivergence=\{handleDismissDivergence\}/);
  assert.match(record, /const handleDismissDivergence = useCallback\(/);
  assert.equal(
    (record.match(/\(s\) => s\.metadataDivergence !== null/g) ?? []).length,
    2,
    'both completion guards must wait for an explicit resolution'
  );
});

test('a retained identity copy stays protected by the durability and nav guards', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');

  // The slot is marked success while its local copy is deliberately kept, so
  // every guard keyed on "not success" would skip exactly the copy that must
  // survive a kill or a navigation away.
  assert.match(
    record,
    /slotHasRecoverableAudio\(s\) &&\s*s\.uploadStatus === 'success' &&\s*s\.metadataDivergence\?\.tier === 'identity'/
  );
  assert.match(
    record,
    /slot\.uploadStatus !== 'success' \|\|\s*slot\.metadataDivergence\?\.tier === 'identity'/
  );
});

test('separate submission gets a fresh durable id, promoted segments, and an actual submit', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const convert = record.slice(
    record.indexOf('const persistPostConfirmSeparateSubmission = useCallback'),
    record.indexOf('const handleDismissDivergence = useCallback')
  );
  // The original id is about to be tombstoned, and a tombstone means "already
  // submitted" to loadDraft and cleanupOrphaned — reusing it would delete the
  // replacement copy the vet just asked for.
  assert.match(convert, /recordingId: newDurableRecordingId\(\)/);
  const freshIdAt = convert.indexOf('recordingId: newDurableRecordingId()');
  const tombstoneAt = convert.indexOf('durableTombstone.add(durable.recordingId)');
  assert.ok(freshIdAt > -1 && tombstoneAt > freshIdAt);

  const resubmit = record.slice(
    record.indexOf('const handleResubmitAsNew = useCallback'),
    record.indexOf('const handleSubmitSingle = useCallback')
  );
  // saveDraft promoted the segments and deleted the old files, and
  // RESET_UPLOAD_ATTEMPT does not carry segments.
  assert.match(resubmit, /type: 'REPLACE_ALL_SEGMENTS',\s*slotId: slot\.id,\s*segments: restarted\.segments,/);
  assert.match(resubmit, /runSingleSubmit\(restarted\);/);
  assert.match(resubmit, /markSubmitIntent\(\[slot\.id\]\)/);
  assert.match(resubmit, /clearSubmitIntent\(\[slot\.id\]\)/);
});

test('releasing the local copy reports failure instead of claiming success', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const releaseBlock = record.slice(
    record.indexOf('const handleReleaseLocalCopy = useCallback'),
    record.indexOf('const persistPostConfirmSeparateSubmission = useCallback')
  );
  // Clearing the card on an unproven delete tells the vet the copy is gone
  // while a stale draft survives to rediscover the same conflict later.
  assert.match(releaseBlock, /if \(!draftDeleted \|\| !scopeIsCurrent\(\)\) \{\s*reportCleanupFailed\(\);/);
  assert.match(releaseBlock, /METADATA_DIVERGENCE_COPY\.releaseLocalCopyFailedTitle/);
  const failAt = releaseBlock.indexOf('if (!draftDeleted || !scopeIsCurrent()) {');
  const clearAt = releaseBlock.indexOf("type: 'SET_METADATA_DIVERGENCE'");
  assert.ok(failAt > -1 && clearAt > failAt, 'the card may only be cleared after a proven delete');
});

test('a retained copy is exempt from completed-upload draft cleanup', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');

  // The upload marks the slot completed even when it holds the local copy back,
  // so the background persist would save the held draft and this path would
  // immediately delete the draft and audio it just wrote.
  assert.match(
    record,
    /if \(completedUploadSlotIdsRef\.current\.has\(slotId\)\) \{[\s\S]{0,600}?if \(slot\.metadataDivergence\?\.tier === 'identity'\) return;/
  );
  assert.match(
    record,
    /completedUploadSlotIdsRef\.current\.has\(slotId\) &&\s*slot\.metadataDivergence\?\.tier !== 'identity'/
  );
});

test('acknowledging the last notice runs the transition the submit deferred', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');

  // Clearing the field alone left the vet on a finished session with no way out
  // but manual navigation. The ORIGINAL transition is held as a closure so a
  // single submit still lands on its detail and Submit All on the list.
  assert.match(record, /const deferredSuccessTransitionRef = useRef<\(\(\) => void\) \| null>\(null\)/);
  assert.match(record, /const runDeferredSuccessTransition = useCallback\(/);
  assert.match(record, /const stillBlocked = sessionRef\.current\.slots\.some\(/);
  assert.match(record, /const completeSingleSubmit = \(\) => \{/);
  assert.match(record, /const completeSubmitAll = \(\) => \{/);
  // Only when a notice is the sole reason to stay — other unfinished slots must
  // keep the session regardless, and resuming would reset it under them.
  assert.match(
    record,
    /hasUnresolvedDivergence && !otherSlotsWithRecordings\s*\?\s*completeSingleSubmit\s*:\s*null/
  );
  // Both resolutions that leave the vet on the screen must release it.
  assert.equal(
    (record.match(/runDeferredSuccessTransition\((slotId|slot\.id)\)/g) ?? []).length,
    2
  );
  // A fresh submit supersedes the deferred one.
  assert.match(record, /deferredSuccessTransitionRef\.current = null;\s*\n\s*\/\/ The confirmation promised a submission/);
});

test('the release transaction is bound to its auth scope and needs a persisted tombstone', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const releaseBlock = record.slice(
    record.indexOf('const handleReleaseLocalCopy = useCallback'),
    record.indexOf('const persistPostConfirmSeparateSubmission = useCallback')
  );

  // draftStorage and the tombstone key off the CURRENT user: an account change
  // mid-delete would prove absence in the replacement user's namespace and
  // tombstone there, while the purge destroys this user's manifest.
  assert.match(releaseBlock, /const scopeIsCurrent = \(\) =>/);
  assert.ok(
    (releaseBlock.match(/scopeIsCurrent\(\)/g) ?? []).length >= 4,
    'scope must be rechecked across the release transaction'
  );
  // add() reports a failed write by RESOLVING false, so .catch() alone would
  // purge with no guard protecting the confirmed server row.
  assert.match(releaseBlock, /const tombstoned = await durableTombstone\s*\.add\(durable\.recordingId\)\s*\.catch\(\(\) => false\);/);
  assert.match(releaseBlock, /if \(!tombstoned \|\| !scopeIsCurrent\(\)\) \{\s*reportCleanupFailed\(\);\s*return;\s*\}/);
  const tombstonedAt = releaseBlock.indexOf('const tombstoned =');
  const purgeAt = releaseBlock.indexOf('purgeAfterUpload');
  assert.ok(tombstonedAt > -1 && purgeAt > tombstonedAt);
});

test('a timed-out conversion never races a restart of the original slot', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const resubmit = record.slice(
    record.indexOf('const handleResubmitAsNew = useCallback'),
    record.indexOf('const handleSubmitSingle = useCallback')
  );

  // withPromiseTimeout recovers the UI but cannot cancel the conversion, which
  // may already have persisted the loose-copy pointer.
  assert.match(resubmit, /let timedOut = false;/);
  assert.match(resubmit, /if \(timedOut\) \{/);
  // Waiting for settlement left the submit intent set, so claimReconcileLock
  // kept refusing and "Try again" pointed at inert controls until a restart.
  // The generation bump makes every remaining step a no-op, which is what
  // makes releasing the gate immediately safe.
  assert.match(resubmit, /reconcileGenerationRef\.current \+= 1;/);
  // The submit intent is freed so the rest of the session works, but this
  // slot's lock is held until the in-flight saveDraft() settles — otherwise a
  // retry could persist the replacement key only for that older write to land
  // afterwards and restore the original confirmed identity.
  assert.match(resubmit, /clearSubmitIntent\(\[slot\.id\]\);/);
  assert.match(resubmit, /await conversion\.catch\(\(\) => \{\}\);\s*return;/);
  assert.match(resubmit, /METADATA_DIVERGENCE_COPY\.resubmitStillFinishingTitle/);
  assert.match(
    resubmit,
    /persistPostConfirmSeparateSubmission\(\s*slot,\s*\(\) => reconcileGenerationRef\.current !== generation,\s*\)/
  );
  const timeoutAt = resubmit.indexOf('if (timedOut) {');
  const restartAt = resubmit.indexOf('persistControlledUploadRestart(converted ?? slot)');
  assert.ok(timeoutAt > -1 && restartAt > timeoutAt, 'the timeout branch must return before any restart');
});

test('an identity divergence with no local bytes becomes a server-only conflict', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const card = await read('src/components/PatientSlotCard.tsx');

  // Confirmation-only recovery reaches the hold-back with the local audio
  // already gone; holding then promises a copy that does not exist and offers
  // "submit separately" that can only fail preflight.
  assert.match(
    record,
    /const holdDurableLocalCopy =\s*divergenceReport\?\.tier === 'identity' && localAudioAvailableForRestart;/
  );
  assert.match(
    record,
    /if \(divergenceReport\?\.tier === 'identity' && !localAudioAvailableForRestart\) \{[\s\S]{0,400}?tier: 'unknown',/
  );
  // ...and that tier must be acknowledgeable, or the guard strands the vet.
  assert.match(card, /slot\.metadataDivergence\.tier === 'unknown'\) && \(/);
});

test('species and breed block adoption when no stronger anchor can disambiguate', async () => {
  const identity = await read('src/api/metadataIdentity.ts');
  const recordings = await read('src/api/recordings.ts');
  const mismatch = await read('src/api/metadataMismatch.ts');

  // Two charts in one practice can share a patient AND client name. With a
  // blank pimsPatientId on both sides, species/breed are the only remaining
  // evidence that the server resolved the other chart — and the adopt path is
  // about to delete the only local copy.
  assert.match(mismatch, /adoptDeletionGate\?: boolean;/);
  assert.match(recordings, /adoptDeletionGate: isAdoptMetadataOrigin\(origin\),/);
  assert.match(identity, /const PROFILE_DISAMBIGUATORS: readonly string\[\] = \['species', 'breed'\];/);
  assert.match(identity, /if \(opts\.adoptDeletionGate\) \{/);
  // appointmentType is the only VISIT-level discriminator: patientName,
  // clientName and pimsPatientId all identify the PATIENT, so a stale intent
  // resolving to that patient's other visit matches on every one of them.
  assert.match(identity, /const VISIT_DISAMBIGUATORS: readonly string\[\] = \['appointmentType'\];/);
  assert.match(
    identity,
    /const promote = anchorUsable\s*\? VISIT_DISAMBIGUATORS\s*: \[\.\.\.VISIT_DISAMBIGUATORS, \.\.\.PROFILE_DISAMBIGUATORS\];/
  );
  // ...and it stays descriptive in the tier map, where it cannot mis-link.
  assert.match(identity, /appointmentType: 'descriptive',/);
  // An absent key is not agreement: the server omits the flat alias whenever
  // the patient relation was not loaded.
  assert.match(identity, /if \(!Object\.prototype\.hasOwnProperty\.call\(recording, 'pimsPatientId'\)\) return false;/);
  // They stay descriptive everywhere else.
  assert.match(identity, /species: 'descriptive',\n\s*breed: 'descriptive',/);
});

test('reconciliation actions are serialized and inert while one runs', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const card = await read('src/components/PatientSlotCard.tsx');

  // Both actions take seconds (a file copy, SecureStore writes, a native purge)
  // with their buttons still on screen, and they mutate the same draft, copy
  // URI, and manifest. A second tap — or the other action — would run
  // concurrently against half-applied state.
  assert.match(record, /const claimReconcileLock = useCallback\(/);
  assert.match(record, /reconcilingSlotIdRef\.current !== null \|\|\s*submitIntentSlotIdsRef\.current\.has\(slotId\) \|\|\s*uploadRestartSlotIdsRef\.current\.has\(slotId\)/);
  assert.equal(
    (record.match(/if \(!claimReconcileLock\(slot\.id\)\) return;/g) ?? []).length,
    2,
    'both reconciliation actions must claim the lock'
  );
  // Both release it on every exit — but only when they still OWN it: the
  // watchdog may have freed it already and another slot may have claimed it,
  // and releasing again would re-enable mutations underneath a newer
  // transaction that is mid-delete.
  // Two owner-checked exits (release + conversion) plus the watchdog's own,
  // which fires only when no native purge is outstanding.
  assert.equal(
    (record.match(/releaseReconcileLock\(\);/g) ?? []).length,
    3,
    'both transactions release on exit, and the watchdog can too'
  );
  assert.match(
    record,
    /reconcilingSlotIdRef\.current === slot\.id &&\s*reconcileGenerationRef\.current === releaseGeneration/
  );
  assert.match(
    record,
    /reconcilingSlotIdRef\.current === slot\.id &&\s*reconcileGenerationRef\.current === generation/
  );
  // The ref is the synchronous gate; the state drives the disabled UI.
  assert.match(record, /divergenceActionsBusy=\{reconcilingSlotId !== null\}/);
  assert.equal(
    (card.match(/disabled=\{divergenceActionsBusy\}/g) ?? []).length,
    6,
    'every divergence action button must go inert'
  );
});

test('the 409 confirm probes prove the row is the one that was asked for', async () => {
  const api = await read('src/api/recordings.ts');

  // The probe is a plain GET by id; metadata equality is not identity, and two
  // same-named patients can match on every compared field while this result
  // authorizes deleting the local audio.
  assert.match(
    api,
    /assertCommittedRecordingIdentity\(recordingId, current, 'confirm_409_probe'\);\s*return assertRecordingMatchesMetadataPayload\(/
  );
  assert.match(
    api,
    /assertCommittedRecordingIdentity\(recordingId, current, 'confirm_api_409_probe'\);\s*return assertRecordingMatchesMetadataPayload\(/
  );
});

test('an absent species or breed also fails closed at the adopt gate', async () => {
  const identity = await read('src/api/metadataIdentity.ts');

  // Absent keys never reach descriptiveFields, so the post-loop promotion could
  // not see them: a response that simply OMITS the disambiguator would slip
  // past while a differing one blocked.
  assert.match(identity, /const anchorUsable = pimsAnchorUsable\(recording, payload\);/);
  assert.match(
    identity,
    /opts\.adoptDeletionGate &&\s*normalizeBlank\(submitted\) !== null &&\s*\(VISIT_DISAMBIGUATORS\.includes\(key\) \|\|\s*\(!anchorUsable && PROFILE_DISAMBIGUATORS\.includes\(key\)\)\)/
  );
});

test('stashing cannot destroy a held conflict copy', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');

  // stashSession() skips succeeded slots, but the stash cleanup deletes the
  // local draft for EVERY slot and then resets the session — so the held audio
  // would go with it, and for a durable capture markUploaded() has already
  // removed it from recovery, leaving nothing pointing at it.
  assert.match(record, /const hasUnresolvedHeldCopy = useCallback\(/);
  assert.match(
    record,
    /\(s\) => s\.uploadStatus === 'success' && s\.metadataDivergence\?\.tier === 'identity',/
  );
  assert.equal(
    (record.match(/if \(hasUnresolvedHeldCopy\(\)\) \{/g) ?? []).length,
    2,
    'checked before starting AND after the draft flush await'
  );
  assert.match(record, /METADATA_DIVERGENCE_COPY\.stashBlockedTitle/);
});

test('an abandoned conversion cannot mutate storage afterwards', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const convert = record.slice(
    record.indexOf('const persistPostConfirmSeparateSubmission = useCallback'),
    record.indexOf('const handleDismissDivergence = useCallback')
  );

  // withPromiseTimeout cannot cancel a native call, so abandonment has to be
  // checked by the transaction itself — it rides along with the scope check
  // that already fences every mutation.
  assert.match(record, /const reconcileGenerationRef = useRef\(0\);/);
  assert.match(convert, /isAbandoned: \(\) => boolean = \(\) => false,/);
  assert.match(convert, /const scopeIsCurrent = \(\) =>\s*!isAbandoned\(\) &&/);
});

test('a held durable copy survives a restart, and the hold is released on resolution', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const logic = await read('src/lib/durableAudio/recoveryLogic.ts');
  const recovery = await read('src/lib/durableAudio/durableRecovery.ts');
  const hold = await read('src/lib/durableAudio/reconcileHold.ts');
  const auth = await read('src/auth/AuthProvider.tsx');

  // The divergence is React state and dies with the process, while
  // markUploaded() is permanent — so the next scan saw a confirmed-uploaded
  // manifest, self-healed it, and destroyed the retained copy.
  assert.match(hold, /export const durableReconcileHold = \{/);
  assert.match(hold, /const KEY_PREFIX = 'captivet_durable_reconcile_hold';/);
  // Suppressed BEFORE the confirmed-uploaded and tombstoned branches, both of
  // which are terminal.
  const selectBody = logic.slice(logic.indexOf('export function selectRecoverableSessions'));
  const heldAt = selectBody.indexOf('if (held.has(manifest.recordingId))');
  const uploadedAt = selectBody.indexOf('if (isConfirmedUploaded(manifest))');
  assert.ok(heldAt > -1 && uploadedAt > heldAt, 'the hold must be checked before self-heal');
  assert.match(recovery, /heldRecordingIds,/);
  // User-scoped like every other durable store (shared clinic tablets).
  assert.match(auth, /durableReconcileHold\.setUserId\(scopedUserId\);/);
  assert.equal((auth.match(/durableReconcileHold\.setUserId\(null\)/g) ?? []).length, 2);

  // Held on BOTH durable success paths, and BEFORE markUploaded() — which is
  // what makes the manifest self-heal eligible, so a hold written after it
  // leaves a crash window and an ignored failure leaves none at all.
  assert.equal(
    (record.match(/\? await addReconcileHoldForUser\(uid, durable\.recordingId\)/g) ?? []).length,
    2,
    'both paths must persist the hold, and honour the result'
  );
  assert.match(record, /if \(nativeManifest && \(!holdDurableLocalCopy \|\| holdPersisted\)\) \{/);
  assert.match(record, /if \(hasNativeManifest && \(!holdIdentityCopy \|\| identityHoldPersisted\)\) \{/);
  assert.equal(
    (record.match(/durable_identity_hold_not_persisted/g) ?? []).length,
    2,
    'a failed hold write must be reported, not silent'
  );
  // ...and released by every resolution: the release action (only after the
  // delete it authorizes succeeded), the conversion, and a dismissal — each of
  // which must clear BOTH keys, since a standard hold is keyed by draft slot id
  // and a durable one by recordingId — plus the scope-rollback inside
  // addReconcileHoldForUser.
  assert.equal(
    (record.match(/durableReconcileHold\s*\.remove\(/g) ?? []).length,
    8
  );
  // A STANDARD held copy needs the marker too: DraftMetadata carries no
  // divergence field, so evictExpired() would otherwise delete it silently at
  // 30 days as ordinary redundant local data.
  assert.match(record, /let standardHoldPersisted = await addReconcileHoldForUser\(user\.id, holdKey\);/);
  // The result is honoured, not discarded: retried once, then said out loud —
  // deleting the audio to avoid "promising retention" would be the worst of the
  // three outcomes, so the copy stays and the promise stops being silent.
  assert.match(record, /standardHoldPersisted = await addReconcileHoldForUser\(user\.id, holdKey\);/);
  assert.match(record, /METADATA_DIVERGENCE_COPY\.holdUnprotectedTitle/);
  assert.match(record, /standard_identity_hold_not_persisted/);
  const releaseBlock = record.slice(
    record.indexOf('const handleReleaseLocalCopy = useCallback'),
    record.indexOf('const persistPostConfirmSeparateSubmission = useCallback')
  );
  const purgeAt = releaseBlock.indexOf('purgeAfterUpload');
  const unholdAt = releaseBlock.indexOf('durableReconcileHold.remove');
  assert.ok(purgeAt > -1 && unholdAt > purgeAt, 'the hold must outlive the steps it protects');
});

test('the recovery scan defers self-heal when hold membership is unknown', async () => {
  const recovery = await read('src/lib/durableAudio/durableRecovery.ts');
  const hold = await read('src/lib/durableAudio/reconcileHold.ts');

  // Self-heal DELETES a draft and purges audio. An empty set on an unreadable
  // list would say "nothing is held", so one transient Keystore failure would
  // destroy every retained copy at once.
  assert.match(hold, /async listStrict\(\): Promise<\{ known: true; list: string\[\] \} \| \{ known: false \}>/);
  assert.match(recovery, /const holdsKnown = heldRead\.known;/);
  assert.match(recovery, /if \(holdsKnown\) \{\s*for \(const m of toHeal\)/);
  assert.match(recovery, /durable_recovery_selfheal_deferred/);
  assert.doesNotMatch(recovery, /durableReconcileHold\s*\.list\(\)\s*\.catch/);
});

test('an omitted PIMS id fails closed at the adopt gate when we sent one', async () => {
  const identity = await read('src/api/metadataIdentity.ts');

  // The tolerance is a serializer allowance. At the adopt gate it stops being
  // harmless: a same-named chart passes every other check while the strongest
  // identifier we held was never verified against the row.
  assert.match(
    identity,
    /opts\.adoptDeletionGate &&\s*ABSENCE_TOLERATED_FIELDS\.has\(key\) &&\s*normalizeBlank\(submitted\) !== null/
  );
  // Still tolerated on commit responses and for an id we never sent.
  assert.match(identity, /const ABSENCE_TOLERATED_FIELDS: ReadonlySet<string> = new Set\(\['pimsPatientId'\]\);/);
});

test('a held manifest nothing owns is offered, not hidden forever', async () => {
  const logic = await read('src/lib/durableAudio/recoveryLogic.ts');
  const hold = await read('src/lib/durableAudio/reconcileHold.ts');

  // If the draft save failed or the process died before background persistence,
  // the hold survives with no draft or stash referencing it — suppressing there
  // too would leave the audio on disk and permanently unreachable, since the
  // hold is surfaced nowhere else.
  assert.match(logic, /const ownedLocally =\s*input\.draftRecordingIds\.has\(manifest\.recordingId\) \|\|\s*input\.stashRecordingIds\.has\(manifest\.recordingId\);/);
  assert.match(logic, /\} else if \(manifest\.adtsFrameCount > 0\) \{\s*(\/\/[^\n]*\n\s*)*offer\.push\(manifest\);/);

  // The cap REFUSES rather than evicting: dropping the oldest hold would hand a
  // retained recording to the next self-heal with nobody deciding.
  assert.match(hold, /if \(list\.length >= MAX_RECONCILE_HOLDS\) return false;/);
  assert.doesNotMatch(hold, /while \(list\.length > MAX_RECONCILE_HOLDS\) list\.shift\(\);/);
});

test('the deferred transition re-checks for work recorded while the notice sat', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');

  // The closure ends in resetSession(). The submit deferred it only because
  // nothing else was unfinished, but the vet can add a patient and record while
  // the notice is up — running it then would silently discard that audio.
  assert.match(record, /const othersUnfinished = sessionRef\.current\.slots\.some\(/);
  assert.match(
    record,
    /if \(othersUnfinished\) \{\s*deferredSuccessTransitionRef\.current = null;\s*return;\s*\}/
  );
});

test('an omitted non-blank field is reported in its own tier, not swallowed', async () => {
  const identity = await read('src/api/metadataIdentity.ts');

  // unknownFields is invisible: divergenceTier() and buildDivergenceReport()
  // never read it, so a rolling serializer that drops templateId,
  // foreignLanguage, or appointmentType produced no notice at all.
  assert.match(
    identity,
    /if \(!ABSENCE_TOLERATED_FIELDS\.has\(key\) && normalizeBlank\(submitted\) !== null\) \{\s*const tier = METADATA_FIELD_TIERS\[key\];\s*if \(tier === 'processing'\) processingFields\.push\(key\);\s*else if \(tier === 'descriptive'\) descriptiveFields\.push\(key\);/
  );
  // A field already promoted to identity must not also be listed under its
  // declared tier.
  assert.match(identity, /identityFields\.push\(key\);\s*continue;\s*\}/);
});

test('the hold is written for the initiating user, not whoever is scoped later', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');

  // durableReconcileHold keys off its own mutable current user, which the
  // AuthProvider re-points on sign-in. An upload completing across a rapid
  // sign-out/sign-in would write the departing user's id into the ARRIVING
  // user's list and then mark the departing user's manifest uploaded — so the
  // original owner returns to a confirmed manifest with no hold.
  assert.match(record, /const addReconcileHoldForUser = useCallback\(/);
  assert.match(record, /if \(durableReconcileHold\.getUserId\(\) !== userId\) return false;/);
  assert.match(
    record,
    /if \(durableReconcileHold\.getUserId\(\) !== userId\) \{[\s\S]{0,400}?await durableReconcileHold\.remove\(recordingId\)\.catch\(\(\) => \{\}\);\s*return false;/
  );
  // Both durable paths go through it, and neither calls add() directly.
  assert.equal(
    (record.match(/await addReconcileHoldForUser\(uid, durable\.recordingId\)/g) ?? []).length,
    2
  );
  // The only direct add() is inside that helper.
  assert.equal((record.match(/durableReconcileHold\.add\(/g) ?? []).length, 1);
});

test('age eviction never silently deletes a retained conflict copy', async () => {
  const drafts = await read('src/lib/draftStorage.ts');

  // A retained copy is server-confirmed by definition — the upload succeeded and
  // the row's IDENTITY is what diverged — so it reaches the "redundant local
  // data" branch looking ordinary. Nothing in DraftMetadata records the hold.
  const evictAt = drafts.indexOf('async evictExpired(');
  const body = drafts.slice(evictAt);
  const holdAt = body.indexOf('durableReconcileHold');
  const deleteAt = body.indexOf('await this.deleteDraftForUser(userId, draft.slotId)');
  assert.ok(holdAt > -1 && deleteAt > holdAt, 'the hold must be checked before the silent delete');
  // STRICT: has() maps an unreadable list to "not held", and this branch
  // deletes on the answer — anything but a proven not_held must defer.
  assert.match(body, /hasStrict\(draft\.slotId\)\s*\.catch\(\(\) => 'unknown' as const\);\s*if \(slotHold !== 'not_held'\) continue;/);
  assert.match(body, /if \(durableHold !== 'not_held'\) continue;/);
});

test('a server 409 has a way out, not just a dismissal', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const card = await read('src/components/PatientSlotCard.tsx');

  // The recording id is often empty on a fresh prepare conflict, dismissing only
  // hides the notice, and Retry reuses the same upload intent to collect the
  // same 409 — so without rotating the intent the submit dead-ends forever.
  assert.match(
    record,
    /slot\.metadataDivergence\?\.tier === 'identity' \|\|\s*slot\.metadataDivergence\?\.tier === 'unknown';/
  );
  const unknownBlock = card.slice(
    card.indexOf("{slot.metadataDivergence.tier === 'unknown' && ("),
    card.indexOf("{slot.metadataDivergence.tier === 'identity' && (")
  );
  assert.match(unknownBlock, /onResubmitAsNew\?\.\(slot\.id\)/);
});

test('hold mutations are serialized, and the slot is frozen during reconciliation', async () => {
  const hold = await read('src/lib/durableAudio/reconcileHold.ts');
  const record = await read('app/(app)/(tabs)/record.tsx');

  // Two slots can finish identity-divergent uploads at once. Interleaved, both
  // add() calls read the same list and the second write drops the first — while
  // BOTH report success, so both callers mark their manifests uploaded and the
  // dropped one is purged by the next startup scan.
  assert.match(hold, /let mutationChain: Promise<unknown> = Promise\.resolve\(\);/);
  assert.match(hold, /function serialize<T>\(op: \(\) => Promise<T>\): Promise<T>/);
  assert.equal((hold.match(/return serialize\(async \(\) => \{/g) ?? []).length, 2);
  // Re-read inside the lock, or the queued call still writes a stale list.
  assert.match(hold, /return serialize\(async \(\) => \{\s*(\/\/[^\n]*\n\s*)*const loaded = await loadList\(userId\);/);

  // The transaction owns the slot's draft, files, and manifest for seconds:
  // locking only the card's buttons left "Delete & Start Over" live.
  assert.match(record, /if \(reconcilingSlotIdRef\.current === slotId\) return true;/);
  const activeAt = record.indexOf('const isSlotUploadActive = useCallback');
  const lockAt = record.indexOf('if (reconcilingSlotIdRef.current === slotId) return true;');
  assert.ok(activeAt > -1 && lockAt > activeAt);
});

test('an abandoned conversion rechecks before the purge, and standard holds are released', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const convert = record.slice(
    record.indexOf('const persistPostConfirmSeparateSubmission = useCallback'),
    record.indexOf('const handleDismissDivergence = useCallback')
  );

  // The timeout can fire while a hold removal awaits storage; a retry may then
  // be copying to the same URI that this purge is about to destroy.
  const lastRemoveAt = convert.lastIndexOf('durableReconcileHold.remove(');
  const recheckAt = convert.indexOf('if (!scopeIsCurrent()) return null;', lastRemoveAt);
  const purgeAt = convert.indexOf('purgeAfterUpload', lastRemoveAt);
  assert.ok(recheckAt > lastRemoveAt && purgeAt > recheckAt, 'recheck must sit between the removals and the purge');

  // A standard slot skips the conversion, and with it the only hold removal —
  // walking the bounded list toward the cap on every repeat.
  const resubmit = record.slice(
    record.indexOf('const handleResubmitAsNew = useCallback'),
    record.indexOf('const handleSubmitSingle = useCallback')
  );
  assert.match(resubmit, /if \(!converted\) \{\s*await durableReconcileHold\s*\.remove\(slot\.draftSlotId \?\? slot\.id\)/);
});

test('the release transaction is bounded and cannot strand the slot', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');

  // Every step is a SecureStore, Keystore or native-purge call, and those hang
  // rather than reject — so a promise that never settles never reaches its
  // finally, leaving the slot mutation-locked until the app restarts.
  assert.match(record, /const RECONCILE_TRANSACTION_TIMEOUT_MS = 15_000;/);
  assert.match(record, /const releaseGeneration = \+\+reconcileGenerationRef\.current;/);
  assert.match(record, /reconcileGenerationRef\.current === releaseGeneration &&/);
  assert.match(record, /release_local_copy_watchdog_fired/);
  // The watchdog refuses to free the slot while a non-cancellable native purge
  // is outstanding — a generation bump cannot recall it.
  assert.match(record, /let purgeInFlight = false;/);
  assert.match(
    record,
    /if \(!purgeInFlight && reconcilingSlotIdRef\.current === slot\.id\) \{\s*releaseReconcileLock\(\);/
  );
});

test('tombstone mutations are serialized like the holds', async () => {
  const tomb = await read('src/lib/durableAudio/tombstone.ts');

  // A reconciliation action and another slot's upload cleanup can both call
  // add(); interleaved, the second whole-list write drops the first — and a
  // dropped tombstone is a confirmed-uploaded recording whose server row
  // cleanupOrphaned can then delete.
  assert.match(tomb, /let mutationChain: Promise<unknown> = Promise\.resolve\(\);/);
  assert.equal((tomb.match(/return serialize\(async \(\) => \{/g) ?? []).length, 3);
});

test('a held copy survives background autosave and freezes its audio controls', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const card = await read('src/components/PatientSlotCard.tsx');

  // saveDraft has just promoted live state onto the draft-directory URIs, so
  // deleting here removes the directory it only just wrote.
  assert.match(
    record,
    /if \(completedUploadSlotIdsRef\.current\.has\(slot\.id\)\) \{[\s\S]{0,600}?if \(slot\.metadataDivergence\?\.tier !== 'identity'\) \{\s*deleteLocalSlotDraft\(slot\);/
  );
  // Continue Recording is the sharp edge: it flips the slot back to pending
  // while leaving metadataDivergence intact, so new audio can be appended and
  // then deleted by an answer about a different recording.
  assert.match(
    card,
    /const isUploading = slot\.uploadStatus === 'uploading' \|\| identityReconciliationPending;/
  );
});

test('an adopt-path conflict persists its hold, and the watchdog is cancelled', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');

  // The divergence state dies with the process while the manifest can still
  // carry serverRecordingId — so the next scan verifies that row as uploaded,
  // finds no hold, and self-heals the audio behind an unresolved conflict.
  assert.match(
    record,
    /if \(conflictTier === 'identity' && user\?\.id\) \{\s*const conflictHoldKey = slot\.durable\?\.recordingId \?\? slot\.draftSlotId \?\? slot\.id;\s*await addReconcileHoldForUser\(user\.id, conflictHoldKey\);/
  );
  // A watchdog that is not cancelled fires anyway: false warning, bumped
  // generation, and a cleanup-failed alert after a successful removal.
  assert.match(record, /let releaseWatchdog: ReturnType<typeof setTimeout> \| null = null;/);
  assert.match(record, /releaseWatchdog = setTimeout\(\(\) => \{/);
  assert.match(record, /if \(releaseWatchdog\) clearTimeout\(releaseWatchdog\);/);
});

test('a held orphan restores with its conflict, not as a blank adoptable draft', async () => {
  const recovery = await read('app/(app)/durable-recovery.tsx');

  // Restoring blank is the worst resolution: on a record-first account the vet
  // can submit at once, the adopt comparison reads the server's populated
  // values as enrichment of our blanks, accepts that row, and purges the audio.
  assert.match(recovery, /function manifestToDurableSlot\(m: DurableRecordingManifest, held = false\): PatientSlot/);
  assert.match(
    recovery,
    /metadataDivergence: held\s*\? \{ tier: 'identity', fields: \[\], recordingId: m\.serverRecordingId \?\? '' \}\s*: null,/
  );
  // The anchor is dropped so a submit cannot re-adopt the disputed row.
  assert.match(recovery, /serverDraftId: held \? null : \(m\.serverRecordingId \?\? null\),/);
  assert.match(recovery, /const held = await durableReconcileHold\.has\(m\.recordingId\)\.catch\(\(\) => false\);/);
});

test('a restored draft rebuilds its conflict from the persisted hold', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const recovery = await read('app/(app)/durable-recovery.tsx');

  // DraftMetadata has no divergence field, so a restored draft came back with
  // the conflict erased — and the deterministic durable key means the next
  // submit can re-adopt the disputed row and purge the audio, card unseen.
  assert.match(record, /const heldConflictKey = draft\.durable\?\.recordingId \?\? draft\.slotId;/);
  assert.match(record, /const conflictHeld = await durableReconcileHold\s*\.has\(heldConflictKey\)/);
  assert.match(
    record,
    /metadataDivergence: conflictHeld\s*\? \{\s*tier: 'identity',/
  );
  // Discarding a held orphan must release its hold: nothing else can, and the
  // cap is hard.
  assert.match(recovery, /await durableReconcileHold\.remove\(m\.recordingId\)\.catch\(\(\) => \{\}\);/);
});
