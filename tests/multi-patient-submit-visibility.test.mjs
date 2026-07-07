import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('dirty server draft metadata must block stale promotion on submit', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const api = await read('src/api/recordings.ts');
  const retry = await read('src/lib/retryableCleanup.ts');
  const uploadRetry = await read('src/api/uploadRetry.ts');

  assert.match(uploadRetry, /\| 'patch_draft'/);
  assert.match(record, /if \(getUploadPhase\(error\) === 'patch_draft'\) return true/);
  assert.doesNotMatch(record, /draftMetadataSyncBlockedError/);

  const durableSubmit = record.slice(
    record.indexOf('const durableConfirmMetadata ='),
    record.indexOf('const cleanupOutcome', record.indexOf('const durableConfirmMetadata ='))
  );
  assert.match(durableSubmit, /slot\.serverDraftId && slot\.draftMetadataDirty \? slot\.formData : undefined/);
  assert.match(durableSubmit, /durableConfirmMetadata \? \{ confirmMetadata: durableConfirmMetadata \} : \{\}/);

  const segmentSubmit = record.slice(
    record.indexOf('const confirmMetadata ='),
    record.indexOf('let result;')
  );
  assert.match(segmentSubmit, /useExistingDraft && serverDraftId && slot\.draftMetadataDirty \? slot\.formData : undefined/);
  assert.match(record, /confirmMetadata \? \{ confirmMetadata \} : \{\}/);

  assert.match(api, /const metadataPayload = opts\?\.metadata \? normalizeDraftMetadataPayload\(opts\.metadata\) : undefined/);
  assert.match(api, /metadataPayload \? \{ metadata: metadataPayload \} : \{\}/);
  assert.match(api, /recordingMatchesMetadataPayload\(current, metadataPayload\)/);
  assert.match(api, /if \(metadataPayload\) \{/);
  assert.match(api, /phaseError\(\s*'patch_draft'/);
  assert.match(api, /confirmMetadata\?: Partial<CreateRecording>/);
  assert.match(api, /recording\.status !== 'draft'[\s\S]*phaseError\(\s*'patch_draft'/);
  assert.match(api, /isExistingRecording && options\?\.confirmMetadata \? \{ metadata: options\.confirmMetadata \} : \{\}/);

  const syncDraft = record.slice(
    record.indexOf('const syncServerDraft = useCallback'),
    record.indexOf('// Schedule phase 2.')
  );
  assert.match(syncDraft, /if \(outcome === 'success'\) \{/);
  assert.match(syncDraft, /sync_server_draft_metadata_not_synced/);
  assert.doesNotMatch(syncDraft, /outcome === 'success' \|\| outcome === 'transient_failure'/);
  assert.match(retry, /transient_failure';\s*\/\/ retries exhausted — caller must keep local audio recoverable/);
});

test('Submit All uses the same metadata gate as per-slot submit outside record-first', async () => {
  const record = await read('app/(app)/(tabs)/record.tsx');
  const panel = await read('src/components/SubmitPanel.tsx');

  assert.match(record, /function slotHasRequiredSubmitFields\(slot: PatientSlot\): boolean/);
  assert.match(record, /\(recordFirstEnabled \|\| slotHasRequiredSubmitFields\(s\)\) &&\s*s\.uploadStatus !== 'success'/);
  assert.match(record, /recordFirstEnabled=\{recordFirstEnabled\}/);

  assert.match(panel, /recordFirstEnabled\?: boolean/);
  assert.match(panel, /const canSubmitSlot = \(s: PatientSlot\) => recordFirstEnabled \|\| hasRequiredFields\(s\)/);
  assert.match(panel, /readyToUpload = slots\.filter\(\s*\(s\) => hasAudio\(s\) && canSubmitSlot\(s\)/);
  assert.match(panel, /needsDetails/);
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
  assert.match(list, /sortBy: 'submittedAt'/);
  assert.match(list, /sortRecordingsBySubmittedAt/);
  assert.match(list, /useQueries\(\{\s*queries: submittedIds\.map/);
  assert.match(list, /recordingsApi\.get\(id\)/);
  assert.match(list, /refetchOnMount: 'always' as const/);
  assert.match(list, /for \(const recording of recordings\)[\s\S]*for \(const query of submittedRecordingQueries\)/);
  assert.match(list, /const pinSubmitted = <T extends \{ id: string \}>/);
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
  assert.match(record, /deleteRecordingWithRetry\(serverId, 'post_upload_local_cleanup'\)/);
  assert.match(record, /reason: 'user_delete'/);
  assert.match(detail, /recordingsApi\.delete\(id, \{ reason: 'user_delete' \}\)/);
});
