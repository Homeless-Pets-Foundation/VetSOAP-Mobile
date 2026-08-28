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
    /const holdDurableLocalCopy =\s*\(metadataDivergence as MetadataDivergenceReport \| null\)\?\.tier === 'identity';/
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
    /const holdDurableLocalCopy =\s*\(metadataDivergence as MetadataDivergenceReport \| null\)\?\.tier === 'identity';/
  );
  assert.match(
    record,
    /const holdFreshDurableCopy =\s*\(metadataDivergence as MetadataDivergenceReport \| null\)\?\.tier === 'identity';/
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
    /tier: error\.source === 'client_adopt_guard' \? 'identity' : 'unknown',/
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
  const tombstoneAt = releaseBlock.indexOf('durableTombstone.add');
  const purgeAt = releaseBlock.indexOf('purgeAfterUpload');
  assert.ok(tombstoneAt > -1 && purgeAt > -1 && tombstoneAt < purgeAt,
    'the tombstone must be persisted before the audio is purged');
  assert.match(releaseBlock, /if \(draftDeleted\) \{\s*await durableRecorder/);

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
    /const showSubmitCard = .*slot\.uploadStatus !== 'success';/,
    'showSubmitCard must still exclude succeeded slots'
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
  const copyAt = convert.indexOf('safeCopyFile(sourceUri, copyUri)');
  const sizeAt = convert.indexOf('info.size ?? 0) > 0');
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
    /withPromiseTimeout\(\s*persistPostConfirmSeparateSubmission\(slot\),\s*POST_CONFIRM_CONVERSION_TIMEOUT_MS/
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
    /\(slot\.metadataDivergence\.tier === 'processing' \|\|\s*slot\.metadataDivergence\.tier === 'descriptive'\) && \(/
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
  assert.match(releaseBlock, /if \(!draftDeleted\) \{\s*Alert\.alert\(/);
  assert.match(releaseBlock, /METADATA_DIVERGENCE_COPY\.releaseLocalCopyFailedTitle/);
  const failAt = releaseBlock.indexOf('if (!draftDeleted) {');
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
