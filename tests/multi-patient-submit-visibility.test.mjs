import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('dirty server draft metadata is applied through strict preparation and confirmation', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const api = await read('src/api/recordings.ts');
  const retry = await read('src/lib/retryableCleanup.ts');
  const uploadRetry = await read('src/api/uploadRetry.ts');

  assert.match(uploadRetry, /\| 'patch_draft'/);
  assert.match(record, /if \(getUploadPhase\(error\) === 'patch_draft'\) return true/);
  assert.doesNotMatch(record, /draftMetadataSyncBlockedError/);

  assert.match(record, /metadataDirty: !!slot\.draftMetadataDirty/g);
  assert.match(record, /onRecordingPrepared/);
  assert.match(record, /dispatch\(\{ type: 'CLEAR_DRAFT_DIRTY', slotId: slot\.id \}\)/);

  assert.match(api, /function completeUploadMetadata/);
  assert.match(api, /metadata: PendingConfirmMetadata/);
  assert.match(api, /metadata,\s*files/);
  assert.match(api, /postConfirm\(hint\.recordingId, hint, metadata\)/);
  assert.match(api, /const SERVER_ENRICHABLE_BLANK_METADATA_FIELDS = new Set/);
  assert.match(api, /function assertRecordingMatchesMetadataPayload\([\s\S]*allowServerEnrichedBlankFields/);
  assert.match(api, /Object\.prototype\.hasOwnProperty\.call\(recordingData, key\)/);
  assert.match(api, /assertRecordingMatchesMetadataPayload\(value\.recording, metadataAsPayload\(metadata\)/);
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
  assert.match(types, /type: 'MARK_DRAFT_METADATA_DIRTY'; slotId: string/);
  assert.match(types, /preserveDirty\?: boolean/);
  assert.match(session, /case 'MARK_DRAFT_METADATA_DIRTY':/);
  assert.match(session, /draftMetadataDirty: !!slot\.serverDraftId && slot\.draftMetadataDirty/);
  assert.match(session, /draftMetadataDirty: preserveDirty/);
  assert.match(retry, /transient_failure';\s*\/\/ retries exhausted — caller must keep local audio recoverable/);

  const stashTypes = await read('src/types/stash.ts');
  const stashAudio = await read('src/lib/stashAudioManager.ts');
  const useStash = await read('src/hooks/useStashedSessions.ts');
  assert.match(stashTypes, /draftMetadataDirty\?: boolean/);
  assert.match(stashAudio, /draftMetadataDirty: !!slot\.serverDraftId && slot\.draftMetadataDirty/);
  assert.match(useStash, /draftMetadataDirty\?: boolean/);
  assert.match(useStash, /draftMetadataDirty: !!slot\.serverDraftId && \(slot\.draftMetadataDirty === true \|\| slot\.draftMetadataDirty === undefined\)/);
});

test('Submit All uses the same metadata gate as per-slot submit outside record-first', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const panel = await read('src/components/SubmitPanel.tsx');

  assert.match(record, /function slotHasRequiredSubmitFields\(slot: PatientSlot\): boolean/);
  assert.match(record, /const recordedSlotsNeedingDetails = recordFirstEnabled[\s\S]*!slotHasRequiredSubmitFields\(s\)/);
  assert.match(record, /Alert\.alert\(\s*'Add Required Details'/);
  assert.match(record, /await draftStorage\.markDraftMetadataDirty\(slotId\)/);
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
  assert.match(list, /selectedStatusFilter === 'needs_review'[\s\S]*getRecordingReviewStatus\(recording\) === 'needs_review'/);
  assert.match(list, /recordingMatchesStatusFilter\(recording, selectedStatusFilter\)/);
  assert.match(list, /recordingMatchesSearch\(recording, debouncedSearch\)/);
  assert.match(list, /sortBy: 'submittedAt'/);
  assert.match(list, /sortRecordingsBySubmittedAt/);
  assert.match(list, /useQueries\(\{\s*queries: submittedIds\.map/);
  assert.match(list, /recordingsApi\.get\(id\)/);
  assert.match(list, /refetchOnMount: 'always' as const/);
  assert.match(list, /for \(const recording of recordings\)[\s\S]*for \(const query of submittedRecordingQueries\)/);
  assert.match(list, /for \(const query of submittedRecordingQueries\)[\s\S]*submittedIdSet\.has\(recording\.id\)\) map\.set\(recording\.id, recording\)/);
  assert.match(list, /const pinSubmitted = \(items: Recording\[\]\): Recording\[\] =>/);
  assert.match(list, /\}, \[debouncedSearch, mergedDrafts, recordings, selectedStatusFilter, submittedIds, submittedIdSet, submittedRecordingsById\]\)/);
  assert.match(list, /highlighted=\{submittedIdSet\.has\(item\.id\)\}/);
  assert.match(list, /\{submittedIds\.length\} of \{submittedIds\.length\} submitted/);

  assert.match(card, /highlighted\?: boolean/);
  assert.match(card, /highlighted = false/);
  assert.match(card, /highlighted \? 'border-brand-500 bg-brand-50 dark:bg-surface-sunken' : ''/);
  assert.match(card, /prev\.highlighted === next\.highlighted/);

  const home = await read('app/(app)/(tabs)/index.tsx');
  assert.match(home, /sortBy: 'submittedAt'/);

  assert.match(api, /function shouldFallbackSubmittedAtSort\(error: unknown, params: ListRecordingsParams\): boolean/);
  assert.match(api, /error instanceof ApiError && error\.status === 400 && params\.sortBy === 'submittedAt'/);
  assert.match(api, /return await apiClient\.get\('\/api\/recordings', sanitized\)/);
  assert.match(api, /\.\.\.sanitized, sortBy: 'createdAt'/);
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
