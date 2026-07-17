// Source-invariant guards for the durable-recorder plan
// (docs/prevent-unsaved-recording-loss-plan.md). These lock in the load-bearing
// wiring that unit tests can't exercise on-device.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (p) => readFile(new URL(p, root), 'utf8');

test('native module: package + config + no-throw lazy bridge', async () => {
  const cfg = JSON.parse(await read('modules/captivet-durable-recorder/expo-module.config.json'));
  assert.equal(cfg.android.modules[0], 'expo.modules.captivetdurablerecorder.CaptivetDurableRecorderModule');
  assert.equal(cfg.ios.modules[0], 'CaptivetDurableRecorderModule');
  const index = await read('modules/captivet-durable-recorder/index.ts');
  // Lazy require + graceful degrade (Rule 1/19).
  assert.match(index, /requireOptionalNativeModule/);
  assert.match(index, /class DurableRecorderUnavailableError/);
  // Read ops degrade to null/[] when unavailable (no throw).
  assert.match(index, /export async function listRecoverableSessions/);
});

test('audio-focus bridge cannot crash Record route when native module is absent', async () => {
  const index = await read('modules/captivet-audio-focus/index.ts');
  assert.match(index, /requireOptionalNativeModule/);
  assert.match(index, /function getNativeModule/);
  assert.doesNotMatch(index, /import \{ requireNativeModule/);
  assert.match(index, /if \(!nativeModule\) return/);
});

test('Android module declares a microphone foreground service', async () => {
  const manifest = await read('modules/captivet-durable-recorder/android/src/main/AndroidManifest.xml');
  assert.match(manifest, /foregroundServiceType="microphone"/);
});

test('native encoder failures are not silently swallowed (invariant 12/13)', async () => {
  // Android: drain loop escalates a mid-recording encoder failure instead of
  // leaving mic/wakelock/FGS held with no frames + no JS error.
  const kt = await read(
    'modules/captivet-durable-recorder/android/src/main/java/expo/modules/captivetdurablerecorder/DurableRecorderEngine.kt',
  );
  assert.match(kt, /if \(running\) handleFatalWorker\(DurableErrors\.ENCODER/);
  // iOS: consecutive AAC encode errors escalate to a graceful stop (frames kept).
  const swift = await read('modules/captivet-durable-recorder/ios/DurableRecorderEngine.swift');
  assert.match(swift, /encoderErrorStreak \+= 1/);
  assert.match(swift, /gracefulStopLocked\(reason: "error", errorCode: "encoder_failed"\)/);
  // iOS: resume never drifts the locked sample rate (fail-visibly, no 24 kHz splice).
  assert.match(swift, /buildConverters\(rate: self\.sampleRate, bits: self\.bitrate, allowFallback: false\)/);
  assert.match(swift, /rate == 16000 && allowFallback/);
});

test('recordings.createWithFile: explicit/derived filename, not hardcoded m4a', async () => {
  const src = await read('src/api/recordings.ts');
  // The presign call must not hardcode the filename (it derives it instead).
  assert.doesNotMatch(src, /getUploadUrl\(\s*recording\.id,\s*'recording\.m4a'/);
  assert.match(src, /function deriveUploadFileName/);
  assert.match(src, /options\?\.fileName \?\? deriveUploadFileName/);
  assert.match(src, /'audio\/aac': 'aac'/);
  // create() accepts a deterministic idempotency key; preparation is awaited
  // BEFORE the R2 PUT so the canonical server id can be persisted.
  assert.match(src, /idempotencyKey\?: string/);
  assert.match(src, /options\?\.idempotencyKey \?\? generateIdempotencyKey\(\)/);
  assert.match(src, /onRecordingPrepared\?/);
  assert.match(src, /await invokePreparedCallback\(options\.onRecordingPrepared/);
});

test('client.ts: 426 is a dedicated terminal-non-auth branch (no refresh/retry)', async () => {
  const src = await read('src/api/client.ts');
  assert.match(src, /resp\.status === 426/);
  assert.match(src, /UPGRADE_REQUIRED/);
  // caches min-version + durable flag from response headers
  assert.match(src, /x-minimum-app-version/);
  assert.match(src, /x-durable-capture-enabled/);
  // 426 handling re-runs on the FINAL response after a 401/428 retry, so a
  // retried 426 still caches the floor + throws (never falls through to generic).
  assert.match(src, /const handleUpgradeResponse = async/);
  assert.match(src, /if \(retried\) await handleUpgradeResponse\(response\)/);
});

test('durable capture flag is server-driven, default off', async () => {
  const src = await read('src/lib/durableFlag.ts');
  assert.match(src, /const forceCapture = process\.env\.EXPO_PUBLIC_FORCE_DURABLE_CAPTURE === 'true'/);
  assert.match(src, /let captureEnabled = forceCapture/);
  assert.match(src, /export function isDurableCaptureEnabled/);
});

test('uploadSlot durable order: markUploaded -> deleteDraft -> purge+tombstone', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');
  // Upload the truncated complete-frame prefix (durableUploadUri), NOT the raw file.
  assert.match(src, /createWithFile\(\s*slot\.formData,\s*durableUploadUri,\s*'audio\/aac'/);
  assert.match(src, /idempotencyKey: durableUploadIdempotencyKey\(durable\.recordingId\)/);
  assert.match(src, /setServerRecordingId\(\{ userId: uid, recordingId: durable\.recordingId/);
  // markUploaded appears before deleteDraft which appears before purgeAfterUpload.
  const iMark = src.indexOf('.markUploaded({ userId: uid, recordingId: durable.recordingId, confirmedUploadAt');
  const iDelete = src.indexOf('await draftStorage.deleteDraft(slot.id);', iMark);
  const iPurge = src.indexOf('.purgeAfterUpload({ userId: uid, recordingId: durable.recordingId })', iDelete);
  assert.ok(iMark > 0 && iDelete > iMark && iPurge > iDelete, 'durable post-upload order must hold');
  assert.match(src, /durableTombstone\.add\(durable\.recordingId\)/);
  // durable upload bypasses maybeSplitForUpload (that path is for legacy segments).
  assert.match(src, /if \(slot\.durable\) \{/);
});

test('uploadSlot durable: freeze the complete-ADTS-frame prefix before upload', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');
  // Always snapshot completeFrameBytes for a native manifest. Even when the
  // anchor equals the observed size, the live recorder source can grow between
  // preflight and the native PUT; the temp prefix must remain immutable.
  assert.match(src, /const completeFrameBytes = manifest\?\.audioFile\.completeFrameBytes \?\? 0/);
  assert.match(src, /if \(hasNativeManifest\) \{/);
  assert.match(src, /completeFrameBytes <= 0 \|\| completeFrameBytes > durableSizeBytes/);
  assert.match(src, /writeFilePrefix\(durableUri, tempUri, completeFrameBytes\)/);
  assert.match(src, /breadcrumb\('upload', 'durable_snapshot_created'/);
  assert.doesNotMatch(src, /completeFrameBytes > 0 && completeFrameBytes < durableSizeBytes/);
  // The temp prefix is cleaned up on both success and failure.
  assert.match(src, /if \(durablePrefixTempUri\) safeDeleteFile\(durablePrefixTempUri\)/);
  // fileOps exposes the streaming prefix copy.
  const fileOps = await read('src/lib/fileOps.ts');
  assert.match(fileOps, /export function writeFilePrefix\(sourceUri: string, destUri: string, byteCount: number\): boolean/);
});

test('recording controls cannot mutate a slot while its upload owns the audio', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');
  const card = await read('src/components/PatientSlotCard.tsx');

  assert.match(src, /const isSlotUploadActive = useCallback/);
  assert.match(src, /uploadingSlotIdsRef\.current\.has\(slotId\)/);
  assert.match(src, /function showUploadInProgressAlert\(\): void/);
  for (const handler of ['handleStart', 'handleContinueRecording', 'handleRecordAgain', 'handleRemove', 'handleEditRecording']) {
    const start = src.indexOf(`const ${handler} = useCallback`);
    assert.ok(start > -1, `${handler} must exist`);
    assert.match(src.slice(start, start + 900), /isSlotUploadActive\(slotId\)/);
  }

  assert.match(card, /const isUploading = slot\.uploadStatus === 'uploading'/);
  assert.match(card, /audioState === 'idle' && !isUploading/);
  assert.match(card, /canContinueDurable = isDurableSlot && !isUploading/);
});

test('uploadSlot durable: preparation sends the complete current metadata snapshot', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');
  const api = await read('src/api/recordings.ts');
  const iDurableBranch = src.indexOf('if (slot.durable) {');
  const iCreateWithFile = src.indexOf("'audio/aac'", iDurableBranch);
  assert.ok(iCreateWithFile > iDurableBranch);
  assert.match(src, /metadataDirty: !!slot\.draftMetadataDirty/);
  assert.match(api, /const metadata = completeUploadMetadata\(data\)/);
  assert.match(api, /requestPreparation\(existingRecordingId, idempotencyKey, metadata, descriptors\)/);
  assert.match(api, /postConfirm\(hint\.recordingId, hint, metadata\)/);
});

test('direct confirmation cannot regress to PATCH-oriented partial metadata', async () => {
  const api = await read('src/api/recordings.ts');
  const directConfirm = api.slice(
    api.indexOf('async confirmUpload('),
    api.indexOf('async prepareUpload(', api.indexOf('async confirmUpload(')),
  );

  assert.match(directConfirm, /metadata\?: CreateRecording/);
  assert.match(directConfirm, /completeUploadMetadata\(opts\.metadata\)/);
  assert.doesNotMatch(directConfirm, /normalizeDraftMetadataPayload/);
});

test('durable submit telemetry reports the native file and manifest duration', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');

  assert.match(
    src,
    /slot\.durable\s*\? slot\.durable\.durationMs \/ 1000\s*:\s*slot\.segments\.reduce/,
  );
  assert.match(src, /const segmentCount = slot\.durable \? 1 : slot\.segments\.length/);
  const durableUpload = src.slice(
    src.indexOf('// ── Durable AAC upload'),
    src.indexOf('// Pre-flight: read local segment sizes'),
  );
  assert.match(durableUpload, /segment_count: segmentCount/);
  assert.doesNotMatch(durableUpload, /segment_count: 0/);
});

test('draftStorage: durable-aware orphan/audio checks + metadata-only save', async () => {
  const src = await read('src/lib/draftStorage.ts');
  assert.match(src, /if \(slot\.durable\) \{/); // metadata-only durable save branch
  assert.match(src, /meta\.durable && isValidDurableId\(meta\.durable\.recordingId\)/); // draftHasLocalAudio
  // cleanupOrphaned: durable skip-unless-purged + getStatus reconcile + fail closed
  assert.match(src, /const durableId =/);
  assert.match(src, /if \(!getStatus \|\| !isOnline \|\| !draft\.serverDraftId\) \{/);
  assert.match(src, /status === null\) continue; \/\/ unverifiable -> defer/);
});

test('stash round-trip: durable through all 3 Rule 20 sites', async () => {
  const stashTypes = await read('src/types/stash.ts');
  assert.match(stashTypes, /durable\?: DurableSlotRef \| null/); // site 1
  assert.match(stashTypes, /draftMetadataDirty\?: boolean/);
  const audioMgr = await read('src/lib/stashAudioManager.ts');
  // site 2 (write): the pointer is carried through, with a vault-restored
  // recoveredAudioUri re-pointed into the stash dir (see the dedicated test below).
  assert.match(audioMgr, /let stashedDurable = slot\.durable \?\? null/);
  assert.match(audioMgr, /draftMetadataDirty: !!slot\.serverDraftId && slot\.draftMetadataDirty/);
  assert.match(audioMgr, /durable: stashedDurable,/);
  const useStash = await read('src/hooks/useStashedSessions.ts');
  assert.match(useStash, /const durable = slot\.durable \?\? null/); // site 3 (read)
  assert.match(useStash, /draftMetadataDirty: !!slot\.serverDraftId && \(slot\.draftMetadataDirty === true \|\| slot\.draftMetadataDirty === undefined\)/);
});

test('vault preserves durable manifests as audio', async () => {
  const src = await read('src/lib/supportStaffRecoveryVault.ts');
  assert.match(src, /function buildSlotHasDurable/);
  assert.match(src, /buildSlotHasDurable\(slot\.durable\)/); // itemHasAudio / filters
  assert.match(src, /durable: draft\.durable \?\? null/);
});

test('AuthProvider runs the durable recovery scan in the post-setUserId one-shot', async () => {
  const src = await read('src/auth/AuthProvider.tsx');
  assert.match(src, /durableTombstone\.setUserId\(scopedUserId\)/);
  assert.match(src, /durableActiveStore\.setUserId\(scopedUserId\)/);
  assert.match(src, /runDurableRecoveryScan\(scopedUserId\)/);
  // scope reset on both sign-out paths (data preserved, only scope cleared)
  const resets = src.match(/durableRecoveryStore\.clear\(\)/g) ?? [];
  assert.ok(resets.length >= 2, `expected >=2 durableRecoveryStore.clear(), found ${resets.length}`);
});

test('record.tsx durable capture: ctx+watchdog, silent-guard peak, Continue resumes, focus skip', async () => {
  const src = await read('app/(app)/(tabs)/record.tsx');
  assert.match(src, /withDurableOpWatchdog\(\s*recorder\.start\(\{ userId: user\.id, slotId, recordingId \}\)/);
  assert.match(src, /slot\.durable\.peakDb <= SILENT_METERING_THRESHOLD_DB/); // synthetic silent guard
  assert.doesNotMatch(src, /if \(slot\?\.durable\) \{[\s\S]*?Adding more audio to it is not supported/);
  assert.match(src, /if \(slot\?\.durable\) startRecordingForSlot\(slotId\)/);
  assert.match(src, /if \(durableActiveRef\.current\) return; \/\/ durable module owns this/);
  assert.match(src, /const durableActive = !!recorder\.activeDurableRecordingId;[\s\S]*?const isActive = !durableActive &&/);
  assert.match(src, /\[recorder\.state, recorder\.activeDurableRecordingId, interruptionPendingResume\]/);
});

test('analytics defines the durable event catalog', async () => {
  const src = await read('src/lib/analytics.ts');
  for (const name of [
    'durable_recorder_started',
    'durable_process_recovered',
    'durable_recovery_available',
    'durable_upload_confirmed',
    'durable_recorder_op_watchdog',
    'durable_low_space_stop',
    'durable_capture_drop',
    'durable_recorder_unavailable',
  ]) {
    assert.match(src, new RegExp(`name: '${name}'`), name);
  }
});

test('secureStorage.clearAll preserves durable keys (allowlist delete, not wildcard)', async () => {
  const src = await read('src/lib/secureStorage.ts');
  // clearAll must not touch the durable_* prefixes.
  assert.doesNotMatch(src, /captivet_durable_/);
});

test('app.config keeps FGS microphone + wakelock + iOS background audio', async () => {
  const src = await read('app.config.ts');
  assert.match(src, /FOREGROUND_SERVICE_MICROPHONE/);
  assert.match(src, /WAKE_LOCK/);
  assert.match(src, /UIBackgroundModes: \['audio'\]/);
});

test('durable-blind read gates are durable-aware (CRITICAL reachability sweep)', async () => {
  // isDraftResumable + recording-detail resume + recovery-intent scan must treat
  // a valid durable pointer (empty segments) as local audio.
  const draftRec = await read('src/lib/draftRecordings.ts');
  assert.match(draftRec, /if \(draft\.durable && isValidDurableId\(draft\.durable\.recordingId\)\) return true/);
  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');
  assert.match(detail, /durableResumable/);
  assert.match(detail, /isValidDurableId\(match\.durable\.recordingId\)/);
  const auth = await read('src/auth/AuthProvider.tsx');
  assert.match(auth, /durableIntentAlive/);
  assert.match(auth, /draft\.segments\.length > 0 \|\| durableIntentAlive/);
  // SubmitPanel uses the shared reachability predicate so durable-only and
  // pending-confirm-only slots cannot disappear from Submit All.
  const panel = await read('src/components/SubmitPanel.tsx');
  assert.match(panel, /import \{ slotHasRecoverableAudio \} from '\.\.\/types\/multiPatient'/);
  assert.match(panel, /const hasAudio = \(s: PatientSlot\) => slotHasRecoverableAudio\(s\)/);
  // Stash orphan recovery keeps a durable-only stash dir.
  const stashMgr = await read('src/lib/stashAudioManager.ts');
  assert.match(stashMgr, /s\.segments\.length > 0 \|\| s\.durable != null/);
});

test('durable free-space gate + hook start timeout are wired', async () => {
  const rec = await read('app/(app)/(tabs)/record.tsx');
  // Pre-record 500/250 MiB gate is actually CALLED (was dead code).
  assert.match(rec, /const spaceGate = checkPreRecordFreeSpace\(\)/);
  assert.match(rec, /if \(spaceGate === 'block'\)/);
  const hook = await read('src/hooks/useAudioRecorder.ts');
  // Hook-internal durable start timeout (unwinds isStartingRef on a hung native start).
  assert.match(hook, /DURABLE_START_TIMEOUT_MS/);
  // Expose the synchronous durable ref if React batches state oddly; otherwise
  // record.tsx can briefly see state='recording' with activeDurableRecordingId=null
  // and start the legacy audio-focus listener, which self-interrupts durable.
  assert.match(hook, /const exposedActiveDurableRecordingId = activeDurableRecordingId \?\? durableRecordingIdRef\.current/);
  assert.match(hook, /activeDurableRecordingId: exposedActiveDurableRecordingId/);
  // The native start is captured then raced against the timeout, so a LATE-
  // resolving start (after we fell back to expo) can be discarded to release the
  // mic/foreground service instead of orphaning the capture.
  assert.match(hook, /const startPromise = durableRecorder\.start\(/);
  assert.match(hook, /Promise\.race\(\[\s*startPromise/);
  assert.match(hook, /durableStartTimedOut = true/);
  assert.match(hook, /if \(durableStartTimedOut\) \{[\s\S]*?durableRecorder\s*\.discard\(/);

  const flag = await read('src/lib/durableFlag.ts');
  assert.match(flag, /EXPO_PUBLIC_FORCE_DURABLE_CAPTURE/);
  assert.match(flag, /if \(forceCapture\) \{[\s\S]*?captureEnabled = true;/);
});

test('support-staff vault preserves durable BYTES + cross-user recovered upload', async () => {
  const vault = await read('src/lib/supportStaffRecoveryVault.ts');
  // Durable audio.aac is COPIED into the neutral vault dir (not just the pointer).
  assert.match(vault, /function copyDurableAudioToRecovery/);
  assert.match(vault, /recoveredAudioUri: copiedUri/);
  // countScoped is durable-aware.
  assert.match(vault, /buildSlotHasDurable\(draft\.durable\)/);
  // record.tsx uploads the recovered copy when there is no native manifest.
  const rec = await read('app/(app)/(tabs)/record.tsx');
  assert.match(rec, /const hasNativeManifest = !!manifest/);
  assert.match(rec, /durable\.recoveredAudioUri/);
  assert.match(rec, /if \(hasNativeManifest\) \{[\s\S]*?markUploaded/);
});

// ── Codex-review regression guards (durable submit-reachability + recovery) ──

test('durable-only slots are submit-reachable (per-patient + Submit All)', async () => {
  // PatientSlotCard: the Submit card must show for a durable slot with empty segments.
  const card = await read('src/components/PatientSlotCard.tsx');
  assert.match(card, /const hasCapturedAudio = slotHasRecoverableAudio\(slot\)/);
  assert.match(card, /showSubmitCard = \(recordFirstEnabled \|\| hasRequiredFields\) && hasCapturedAudio/);
  // SubmitPanel already counts all recoverable audio.
  const panel = await read('src/components/SubmitPanel.tsx');
  assert.match(panel, /const hasAudio = \(s: PatientSlot\) => slotHasRecoverableAudio\(s\)/);
  // Submit All + post-single-submit "others remaining" both include durable slots.
  const rec = await read('app/(app)/(tabs)/record.tsx');
  assert.match(rec, /slotHasRecoverableAudio\(s\) &&\s*\n\s*\(recordFirstEnabled \|\| slotHasRequiredSubmitFields\(s\)\) &&\s*\n\s*s\.uploadStatus !== 'success'/);
  assert.match(rec, /slotHasRecoverableAudio\(s\) \|\| s\.audioState === 'recording' \|\| s\.audioState === 'paused'/);
});

test('Submit All records non-PHI diagnostics when a selected slot uploads no audio', async () => {
  const rec = await read('app/(app)/(tabs)/record.tsx');
  assert.match(rec, /breadcrumb\('upload', 'submit_selected_slot_returned_null'/);
  assert.match(rec, /has_durable: !!failedSnapshot\?\.durable/);
  assert.match(rec, /segment_count: failedSnapshot\?\.segments\.length/);
  assert.match(rec, /audio_state: failedSnapshot\?\.audioState/);
  assert.match(rec, /has_server_draft: !!failedSnapshot\?\.serverDraftId/);
  assert.match(rec, /has_pending_confirm: !!failedSnapshot\?\.pendingConfirm/);
});

test('interrupted durable capture attributes committed duration (not 0)', async () => {
  const hook = await read('src/hooks/useAudioRecorder.ts');
  // committedThroughMs is mirrored into a ref and folded into the durable duration
  // on interruption so a finish taken from the snapshot never saves durationMs=0.
  assert.match(hook, /committedThroughMsRef\.current = e\.committedThroughMs/);
  assert.match(hook, /durableDurationMsRef\.current = Math\.max\(\s*durableDurationMsRef\.current,\s*committedThroughMsRef\.current,?\s*\)/);
});

test('record start is gated by the server min-version floor', async () => {
  const rec = await read('app/(app)/(tabs)/record.tsx');
  assert.match(rec, /import \{ getRecordStartGate, ensureFloorHydrated \} from '\.\.\/\.\.\/\.\.\/src\/lib\/minVersion'/);
  // The gate is consulted at the single mic-start funnel (fresh + Resume→Continue)
  // and hydration is AWAITED first so an offline cold start can't race the floor.
  const iFn = rec.indexOf('const startRecordingForSlot = useCallback(');
  const iHydrate = rec.indexOf('await ensureFloorHydrated()', iFn);
  const iGate = rec.indexOf("getRecordStartGate() === 'block'", iFn);
  assert.ok(iHydrate > iFn && iGate > iHydrate, 'hydration must be awaited before the gate check');
});

test('recovered durable draft preserves the death-surviving server anchor', async () => {
  const draft = await read('src/lib/draftStorage.ts');
  // saveDraft falls back to slot.serverDraftId when no local draft exists yet,
  // while a rotated audio intent is allowed to clear an obsolete disk anchor.
  assert.match(draft, /const resolvedServerDraftId = durableIntentRotated[\s\S]*existingDurable\?\.serverDraftId \?\? slot\.serverDraftId \?\? null/);
  assert.match(draft, /serverDraftId: resolvedServerDraftId/);
  assert.match(draft, /pendingSync: !durableIntentRotated && existingDurable\?\.serverDraftId\s*\?\s*existingDurable\.pendingSync\s*:\s*!resolvedServerDraftId/);
});

test('native self-heal scan returns confirmed-uploaded-but-not-purged manifests', async () => {
  // JS routes confirmed-uploaded manifests to the selfHeal bucket (never offer).
  const logic = await read('src/lib/durableAudio/recoveryLogic.ts');
  assert.match(logic, /if \(isConfirmedUploaded\(manifest\)\) \{[\s\S]*?selfHeal\.push\(manifest\)/);
  // Android: return the uploaded manifest instead of dropping it (was `return null`).
  const kt = await read(
    'modules/captivet-durable-recorder/android/src/main/java/expo/modules/captivetdurablerecorder/DurableRecorderEngine.kt',
  );
  assert.match(kt, /if \(m\.state == DurableState\.UPLOADED \|\| !m\.confirmedUploadAt\.isNullOrEmpty\(\)\) \{[\s\S]*?return m\.toMap\(\)/);
  // iOS: return the uploaded manifest instead of `continue`.
  const swift = await read('modules/captivet-durable-recorder/ios/DurableRecorderEngine.swift');
  assert.match(swift, /if manifest\.isConfirmedUploaded \{[\s\S]*?results\.append\(manifest\.toDictionary\(\)\)/);
});

test('iOS benign route change does not emit a fatal interruption', async () => {
  const swift = await read('modules/captivet-durable-recorder/ios/DurableRecorderEngine.swift');
  // The default (non-oldDeviceUnavailable) route-change branch fsyncs but must NOT
  // emit "interruption" (JS treats every interruption as fatal → orphaned capture).
  const iDefault = swift.indexOf('// Non-fatal route change (new device available, category change)');
  assert.ok(iDefault > 0, 'benign route-change branch must exist');
  const iMediaReset = swift.indexOf('@objc private func handleMediaReset', iDefault);
  const branch = swift.slice(iDefault, iMediaReset);
  assert.doesNotMatch(branch, /emit\("interruption"/);
});

test('recovered slot ids are unique (no constant "recovered" collision)', async () => {
  // JS derives the draft/slot id from the unique recordingId, not manifest.slotId.
  const screen = await read('app/(app)/durable-recovery.tsx');
  assert.match(screen, /const slotId = m\.recordingId/);
  assert.match(screen, /draftSlotId: slotId/);
  assert.match(screen, /params: \{ draftSlotId: m\.recordingId \}/);
  // Android orphan synthesis uses recordingId as slotId (iOS parity), not "recovered".
  const kt = await read(
    'modules/captivet-durable-recorder/android/src/main/java/expo/modules/captivetdurablerecorder/DurableRecorderEngine.kt',
  );
  assert.doesNotMatch(kt, /slotId = "recovered"/);
});

// ── Codex-review round 2 regression guards (PR #126) ──

test('support-staff vault durable copies are truncated to the complete-frame prefix', async () => {
  const src = await read('src/lib/supportStaffRecoveryVault.ts');
  // copyDurableAudioToRecovery uses writeFilePrefix(completeFrameBytes), not a whole-file copy.
  assert.match(src, /completeFrameBytes\?: number/);
  assert.match(src, /writeFilePrefix\(srcUri, destUri, completeFrameBytes\)/);
});

test('support-staff vault restore moves durable AAC to stable storage before deleting the item', async () => {
  const src = await read('src/lib/supportStaffRecoveryVault.ts');
  assert.match(src, /RESTORED_DURABLE_DIR/);
  // The recovered AAC is copied to a stable current-user home and recoveredAudioUri
  // repointed BEFORE saveDraft — so deleteItem() (vault dir) can't orphan it.
  const iCopy = src.indexOf('safeCopyFile(recoveredAudioUri, stableUri)');
  const iSave = src.indexOf('draftStorage.saveDraft(restoredSlot)');
  const iDelete = src.indexOf('await this.deleteItem(user, item.id)');
  assert.ok(iCopy > 0 && iSave > iCopy && iDelete > iSave,
    'copy → saveDraft → deleteItem order must hold');
});

test('durable recovery scan drops results after sign-out (generation guard)', async () => {
  const src = await read('src/lib/durableAudio/durableRecovery.ts');
  assert.match(src, /export function invalidateDurableRecoveries/);
  assert.match(src, /const myGeneration = \+\+scanGeneration/);
  assert.match(src, /if \(myGeneration !== scanGeneration\) return/);
  // AuthProvider invalidates before clearing the store on BOTH sign-out paths.
  const auth = await read('src/auth/AuthProvider.tsx');
  const invalidations = auth.match(/invalidateDurableRecoveries\(\)/g) || [];
  assert.ok(invalidations.length >= 2, 'both sign-out paths must invalidate scans');
});

test('min-version floor is persisted + hydrated across restarts', async () => {
  const src = await read('src/lib/minVersion.ts');
  assert.match(src, /export function hydrateMinVersionFloor/);
  assert.match(src, /export async function ensureFloorHydrated/);
  assert.match(src, /setRawItem\(FLOOR_STORAGE_KEY/);
  assert.match(src, /getRawItem\(FLOOR_STORAGE_KEY/);
  // hydrate only fills an UNKNOWN in-memory value (never downgrades a fresher one).
  assert.match(src, /if \(!cachedFloor && typeof stored === 'string'/);
  // wired at cold-start before any record-start gate check.
  const auth = await read('src/auth/AuthProvider.tsx');
  assert.match(auth, /hydrateMinVersionFloor\(\)\.catch/);
});

test('iOS recovery recounts the bounded tail past the anchor before offering', async () => {
  const swift = await read('modules/captivet-durable-recorder/ios/DurableRecorderEngine.swift');
  // Fast path recounts frames appended after the last commit tick (size > anchor)
  // so upload truncation to completeFrameBytes never drops the tail.
  assert.match(swift, /if size > anchor \{[\s\S]*?AdtsScanner\.scanFile\(url: audioURL, maxBytes: size, startOffset: anchor\)/);
  const writer = await read('modules/captivet-durable-recorder/ios/AdtsWriter.swift');
  assert.match(writer, /static func scanFile\(url: URL, maxBytes: Int, startOffset: Int = 0\)/);
});

// ── Codex-review round 3 regression guards (PR #126) ──

test('durable finish stop is bounded by the op watchdog', async () => {
  const rec = await read('app/(app)/(tabs)/record.tsx');
  // A hung native durable stop after the card is "Saving…" would strand the user;
  // the durable stop is raced against withDurableOpWatchdog(..., 'stop').
  assert.match(rec, /await withDurableOpWatchdog\(recorder\.stop\(\), 'stop'\)/);
});

test('discarding a live durable capture discards its native files before reset', async () => {
  const hook = await read('src/hooks/useAudioRecorder.ts');
  // reset() (the delete/discard variant) discards the active durable recordingId
  // BEFORE resetDurableState() clears it, or recovery re-offers a discarded take.
  const iReset = hook.indexOf('const reset = useCallback(');
  const iDiscard = hook.indexOf('durableRecorder\n        .discard(', iReset);
  const iResetState = hook.indexOf('resetDurableState();', iReset);
  assert.ok(iDiscard > iReset && iResetState > iDiscard, 'discard must precede resetDurableState in reset()');
});

test('durable slots are counted in the unsaved leave/reset guards', async () => {
  const rec = await read('app/(app)/(tabs)/record.tsx');
  // Both unsavedCount (leave guard) and trulyUnsaved (draft-load reset) use the
  // shared isTrulyUnsavedSlot predicate, which covers durable and
  // pending-confirm-only slots while excluding committed drafts (durable on
  // disk + server; preserved via preserveDraftSlotIds on discard).
  assert.match(rec, /function isTrulyUnsavedSlot\(s: PatientSlot\): boolean \{[\s\S]*?slotHasRecoverableAudio\(s\) && !s\.draftSlotId && s\.uploadStatus !== 'success'/);
  assert.match(rec, /const unsavedCount = session\.slots\.filter\(isTrulyUnsavedSlot\)/);
  assert.match(rec, /const trulyUnsaved = currentSlots\.some\(isTrulyUnsavedSlot\)/);
  // Discard paths must thread the preserve list so drafted slots survive.
  assert.match(rec, /preserveDraftSlotIds: collectPreserveDraftSlotIds\(sessionRef\.current\.slots\)/);
  assert.match(rec, /await discardCurrentSession\(\{ preserveDraftSlotIds \}\)/);
});

test('deleteDraft removes a recovered durable AAC but not shared native audio', async () => {
  const src = await read('src/lib/draftStorage.ts');
  const iFn = src.indexOf('async deleteDraft(');
  const iRead = src.indexOf('readDraftChunks(userId, slotId)', iFn);
  const iDelFile = src.indexOf('safeDeleteFile(recoveredAudioUri)', iFn);
  const iDelDir = src.indexOf('safeDeleteDirectory(dir)', iFn);
  assert.ok(iRead > iFn && iDelFile > iRead && iDelDir > iDelFile,
    'deleteDraft must delete recoveredAudioUri before the draft dir');
});

test('durable-capture flag fails closed when the header is absent', async () => {
  const src = await read('src/api/client.ts');
  assert.match(src, /setDurableCaptureFlag\(durableFlag !== null \? durableFlag : false\)/);
});

test('Android durable service stops itself if foreground promotion fails', async () => {
  const kt = await read(
    'modules/captivet-durable-recorder/android/src/main/java/expo/modules/captivetdurablerecorder/DurableRecorderService.kt',
  );
  assert.match(kt, /val promoted = runCatching \{ startForegroundNotification\(\) \}\.isSuccess/);
  assert.match(kt, /if \(!promoted\) \{[\s\S]*?stopSelf\(\)/);
});

test('discardCurrentSession discards a finished durable slot\'s native files', async () => {
  const rec = await read('app/(app)/(tabs)/record.tsx');
  const iFn = rec.indexOf('const discardCurrentSession = useCallback(');
  const iRelease = rec.indexOf('releaseResumedStashIfAny();', iFn);
  // The discard loop (before releaseResumedStashIfAny) discards the durable native
  // recording for a slot being abandoned — reset() only covers the bound recorder.
  const iDiscard = rec.indexOf('.discard({ userId: durableUserId, recordingId: slot.durable.recordingId })', iFn);
  assert.ok(iDiscard > iFn && iDiscard < iRelease, 'discardCurrentSession must discard durable native files');
  assert.match(rec.slice(iFn, iRelease), /if \(slot\.durable\.recoveredAudioUri\) safeDeleteFile\(slot\.durable\.recoveredAudioUri\)/);
});

test('a stopped durable slot shows Continue Recording + Delete & Start Over, not Try Again', async () => {
  const card = await read('src/components/PatientSlotCard.tsx');
  // Durable completed slot (empty segments) gets its own controls branch and the
  // error-recovery Try Again branch explicitly excludes durable.
  assert.match(card, /const canContinueDurable = isDurableSlot && !isUploading && slot\.uploadStatus !== 'success' && !slot\.durable\?\.recoveredAudioUri/);
  assert.match(card, /const canDiscardDurable = isDurableSlot && slot\.uploadStatus !== 'success'/);
  const iDurable = card.indexOf('isStopped && !hasSegments && canDiscardDurable && !isFinishSaving');
  const iTryAgain = card.indexOf('isStopped && !hasSegments && !isDurableSlot && !hasPendingConfirm && !isFinishSaving', iDurable);
  assert.ok(iDurable > 0 && iTryAgain > iDurable, 'durable stopped branch must exist before Try Again branch');
  const durableBranch = card.slice(iDurable, iTryAgain);
  assert.match(durableBranch, /Continue Recording/);
  assert.match(durableBranch, /Delete & Start Over/);
  assert.match(durableBranch, /\{canContinueDurable && \(/);
  assert.match(card, /isStopped && !hasSegments && !isDurableSlot && !hasPendingConfirm && !isFinishSaving/);
});

test('a recovered durable slot can be discarded even when Continue is hidden', async () => {
  const card = await read('src/components/PatientSlotCard.tsx');
  const iDurable = card.indexOf('isStopped && !hasSegments && canDiscardDurable && !isFinishSaving');
  const iTryAgain = card.indexOf('isStopped && !hasSegments && !isDurableSlot && !hasPendingConfirm && !isFinishSaving', iDurable);
  assert.ok(iDurable > 0 && iTryAgain > iDurable, 'durable stopped branch must exist before Try Again branch');
  const durableBranch = card.slice(iDurable, iTryAgain);
  const iContinueGuard = durableBranch.indexOf('{canContinueDurable && (');
  const iDelete = durableBranch.indexOf('Delete & Start Over');
  assert.ok(iContinueGuard > 0 && iDelete > iContinueGuard, 'delete control must not be hidden by canContinueDurable');
});

test('durable Continue re-enters the single start funnel instead of blocking', async () => {
  const rec = await read('app/(app)/(tabs)/record.tsx');
  const iContinue = rec.indexOf('const handleContinueRecording = useCallback(');
  const iRecordAgain = rec.indexOf('const handleRecordAgain = useCallback(', iContinue);
  assert.ok(iContinue > 0 && iRecordAgain > iContinue, 'handleContinueRecording slice not found');
  const body = rec.slice(iContinue, iRecordAgain);
  assert.doesNotMatch(body, /Adding more audio to it is not supported/);
  assert.match(body, /slot\?\.durable && \(slot\.uploadStatus === 'success' \|\| slot\.durable\.recoveredAudioUri\)/);
  assert.doesNotMatch(
    body,
    /deleteOrphanServerRecording\(slot\)/,
    'continuation must retain the stable intent and reusable canonical server row'
  );
  assert.match(body, /continueRecording\(slotId\);/);
  assert.match(body, /startRecordingForSlot\(slotId\);/);
});

test('stopped-state capture effect does not finalize while a durable resume is starting', async () => {
  const rec = await read('app/(app)/(tabs)/record.tsx');
  const iEffect = rec.indexOf('// Effect: capture audio URI when recorder transitions to stopped while bound to a slot');
  const iNext = rec.indexOf('// Keep the multi-patient record-first warning', iEffect);
  assert.ok(iEffect > 0 && iNext > iEffect, 'stopped capture effect slice not found');
  const body = rec.slice(iEffect, iNext);
  const iStopped = body.indexOf("if (recorder.state !== 'stopped')");
  const iStarting = body.indexOf('if (recorder.isStarting)');
  const iDurableFinish = body.indexOf('if (recorder.activeDurableRecordingId && session.recorderBoundToSlotId');
  assert.ok(iStopped > 0 && iStarting > iStopped && iStarting < iDurableFinish, 'isStarting guard must run before durable stopped-finalize branch');
  assert.match(body, /recorder\.isStarting/);
});

test('startRecordingForSlot resumes existing durable before fresh durable start', async () => {
  const rec = await read('app/(app)/(tabs)/record.tsx');
  const iFn = rec.indexOf('const startRecordingForSlot = useCallback(');
  const iExisting = rec.indexOf('const existingDurable = startSlot?.durable ?? null', iFn);
  const iFresh = rec.indexOf('const freshDurable =', iFn);
  assert.ok(iExisting > iFn && iExisting < iFresh, 'existing durable resume branch must run before fresh durable');
  const branch = rec.slice(iExisting, iFresh);
  assert.match(branch, /isDurableCaptureEnabled\(\)/);
  assert.match(branch, /checkPreRecordFreeSpace\(\)/);
  assert.match(branch, /raceDurableActiveWrite\(\s*durableActiveStore\.setActive\(existingDurable\.recordingId, slotId/);
  assert.match(branch, /recorder\.resumeDurable\(\{ userId: user\.id, slotId, durable: existingDurable \}\)/);
  assert.match(branch, /withDurableOpWatchdog\([\s\S]*'resume'/);
});

test('useAudioRecorder exposes resumeDurable without expo fallback and seeds existing stats', async () => {
  const hook = await read('src/hooks/useAudioRecorder.ts');
  assert.match(hook, /export interface DurableResumeContext/);
  assert.match(hook, /resumeDurable: \(ctx: DurableResumeContext\) => Promise<void>/);
  const iResumeDurable = hook.indexOf('const resumeDurable = useCallback(');
  const iResume = hook.indexOf('const resume = useCallback(', iResumeDurable);
  assert.ok(iResumeDurable > 0 && iResume > iResumeDurable, 'resumeDurable must be a distinct hook method before pause/resume');
  const body = hook.slice(iResumeDurable, iResume);
  assert.match(body, /if \(state !== 'idle'\)/);
  assert.match(body, /withDurableTimeout\(\s*durableRecorder\.getManifest\(\{\s*userId: ctx\.userId,\s*recordingId: ctx\.durable\.recordingId,\s*\}\),\s*DURABLE_RESUME_TIMEOUT_MS,\s*'durable resume manifest timed out'/);
  assert.match(body, /withDurableTimeout\(\s*durableRecorder\.resume\(\{\s*userId: ctx\.userId,\s*recordingId: ctx\.durable\.recordingId,\s*\}\),\s*DURABLE_RESUME_TIMEOUT_MS,\s*'durable resume timed out'/);
  assert.match(body, /durableRecorder\.stop\(\{ userId: ctx\.userId, recordingId: ctx\.durable\.recordingId \}\)\.catch/);
  assert.match(body, /const clearResumeStarting = \(\) => \{[\s\S]*resumeInFlightRef\.current = false;[\s\S]*setIsStarting\(false\);[\s\S]*\}/);
  assert.match(body, /handleResumeFailure[\s\S]*clearResumeStarting\(\)/);
  assert.match(body, /if \(manifest\.state !== 'recording'\)/);
  assert.match(body, /durableDurationMsRef\.current = Math\.max\(ctx\.durable\.durationMs, existingManifest\.durationMs\)/);
  assert.match(body, /elapsedBeforeCurrentRunMsRef\.current = durableDurationMsRef\.current/);
  assert.match(body, /durablePeakDbRef\.current = Math\.max\(ctx\.durable\.peakDb, existingManifest\.peakDb\)/);
  assert.match(body, /durableRecorder\.resume[\s\S]*if \(manifest\.state !== 'recording'\)[\s\S]*setState\('recording'\)/);
  assert.doesNotMatch(body, /durableRecorder\.getStatus\(\)/);
  assert.doesNotMatch(body, /prepareToRecordAsync|recorder\.record\(\)|setAudioModeAsync/);
});

test('tab taps and swipes share pause-on-leave patient selection', async () => {
  const rec = await read('app/(app)/(tabs)/record.tsx');
  assert.match(rec, /const selectPatientIndex = useCallback\(/);
  const iSelect = rec.indexOf('const selectPatientIndex = useCallback(');
  const iScrollBegin = rec.indexOf('const handleScrollBegin = useCallback', iSelect);
  const selectBody = rec.slice(iSelect, iScrollBegin);
  assert.match(selectBody, /const leavingSlotId = session\.recorderBoundToSlotId/);
  assert.match(selectBody, /await recorder\.pause\(\)/);
  assert.match(selectBody, /setAudioState\(leavingSlotId, 'paused'\)/);
  assert.match(selectBody, /setActiveIndex\(index\)/);
  assert.match(rec, /onSelectIndex=\{selectPatientIndex\}/);
  assert.match(rec, /selectPatientIndex\(clampedIndex, \{ fromSwipe: true \}\)/);
});

test('durable-only stash failure surfaces the Save Failed alert', async () => {
  const rec = await read('app/(app)/(tabs)/record.tsx');
  // hasRecordings (the Save Failed gate) counts every recoverable slot, or a
  // durable/proof-only stash failure would be silent.
  assert.match(rec, /const hasRecordings = postFlushSession\.slots\.some\(slotHasRecoverableAudio\)/);
});

test('post-upload deleteDraft is verified + retried; loadDraft blocks a tombstoned durable resume', async () => {
  const rec = await read('app/(app)/(tabs)/record.tsx');
  // deleteDraft swallows its own storage errors, so success is VERIFIED via
  // getDraft (not a try/catch) and confirmDraftGone is retried once.
  assert.match(rec, /const confirmDraftGone = async \(\): Promise<boolean>/);
  assert.match(rec, /const still = await draftStorage\.getDraft\(slot\.id\)\.catch\(\(\) => null\);\n\s*return still === null;/);
  assert.match(rec, /let draftDeleted = await confirmDraftGone\(\);\n\s*if \(!draftDeleted\) draftDeleted = await confirmDraftGone\(\);/);
  // loadDraft refuses to resume an already-uploaded (tombstoned) durable draft.
  const iLoad = rec.indexOf('const loadDraft = useCallback(');
  const iGuard = rec.indexOf('durableTombstone\n            .has(draft.durable.recordingId)', iLoad);
  const iRestore = rec.indexOf('restoreSession([restoredSlot])', iLoad);
  assert.ok(iGuard > iLoad && iGuard < iRestore, 'loadDraft must check the tombstone before restoring a durable draft');
  assert.match(rec.slice(iLoad, iRestore), /Already Submitted/);
});

test('durable hook stop is bounded by an internal timeout that always unwinds', async () => {
  const hook = await read('src/hooks/useAudioRecorder.ts');
  const iStop = hook.indexOf('const stop = useCallback(');
  const iRace = hook.indexOf('DURABLE_STOP_TIMEOUT_MS', iStop);
  const iFinally = hook.indexOf('} finally {', iStop);
  const iClear = hook.indexOf('stoppingRef.current = false;', iFinally);
  // The native durable stop is raced against a timeout and the lock/state reset
  // runs in finally, so a hung bridge can't strand stoppingRef=true forever.
  assert.ok(iRace > iStop, 'durable stop must race DURABLE_STOP_TIMEOUT_MS');
  assert.ok(iFinally > iRace && iClear > iFinally, 'durable stop must clear stoppingRef in finally');
});

test('per-slot durable discard paths delete a recovered vault copy', async () => {
  const rec = await read('app/(app)/(tabs)/record.tsx');
  // handleRecordAgain AND handleRemove delete slot.durable.recoveredAudioUri (a
  // native discard() is a no-op for a vault-restored loose .aac).
  const matches = rec.match(/if \(slot\.durable\.recoveredAudioUri\) safeDeleteFile\(slot\.durable\.recoveredAudioUri\)/g) || [];
  assert.ok(matches.length >= 3, 'recordAgain + remove + discardCurrentSession must delete recoveredAudioUri');
});

test('recovery scan suppresses tombstoned recordingIds (never offers them)', async () => {
  const logic = await read('src/lib/durableAudio/recoveryLogic.ts');
  assert.match(logic, /tombstonedRecordingIds\?: ReadonlySet<string>/);
  assert.match(logic, /if \(tombstoned\.has\(manifest\.recordingId\)\)/);
  const scan = await read('src/lib/durableAudio/durableRecovery.ts');
  assert.match(scan, /const tombstonedRecordingIds = new Set<string>\(\)/);
  assert.match(scan, /tombstonedRecordingIds,/);
});

test('support-staff vault fails the whole item when a durable copy drops', async () => {
  const vault = await read('src/lib/supportStaffRecoveryVault.ts');
  assert.match(vault, /copiedDurable < expectedDurable/);
  // itemHasAudio verifies the recovered durable file still exists, not just a valid id.
  assert.match(vault, /function vaultSlotHasDurableAudio/);
  assert.match(vault, /fileExists\(durable\.recoveredAudioUri\)/);
});

test('Android fast-path recovery persists the recovered anchor before returning', async () => {
  const kt = await read(
    'modules/captivet-durable-recorder/android/src/main/java/expo/modules/captivetdurablerecorder/DurableRecorderEngine.kt',
  );
  const iFast = kt.indexOf('if (canTailSeek) {');
  const iWrite = kt.indexOf('runCatching { DurableManifest.writeAtomic(manifestFile, m) }', iFast);
  const iReturn = kt.indexOf('return m.toMap()', iFast);
  assert.ok(iWrite > iFast && iWrite < iReturn, 'fast-path must writeAtomic before returning');
});

test('stashing a vault-restored durable slot copies its recovered AAC into the stash dir', async () => {
  const mgr = await read('src/lib/stashAudioManager.ts');
  // The loose recoveredAudioUri is copied into the stash dir and re-pointed, so
  // stashSession's post-commit deleteDraft can't destroy the stash's only audio.
  assert.match(mgr, /if \(stashedDurable\?\.recoveredAudioUri\)/);
  assert.match(mgr, /new ExpoFile\(stashedDurable\.recoveredAudioUri\)\.copy\(new ExpoFile\(durableDest\)\)/);
  assert.match(mgr, /stashedDurable = \{ \.\.\.stashedDurable, recoveredAudioUri: durableDest \}/);
});

test('DurablePaths NUL-id check uses an escaped literal, not a raw NUL byte', async () => {
  const path = 'modules/captivet-durable-recorder/android/src/main/java/expo/modules/captivetdurablerecorder/DurablePaths.kt';
  const kt = await read(path);
  assert.ok(!kt.includes(String.fromCharCode(0)), 'DurablePaths.kt must not contain a raw NUL byte (git treats it as binary)');
  assert.match(kt, /id\.contains\('\\u0000'\)/);
});

test('durable snapshot folds committed + live duration (no zero-duration on stop fail)', async () => {
  const hook = await read('src/hooks/useAudioRecorder.ts');
  const iSnap = hook.indexOf('const getDurableSnapshot = useCallback(');
  const iMax = hook.indexOf('Math.max(', iSnap);
  const iEnd = hook.indexOf('}, []);', iSnap);
  assert.ok(iMax > iSnap && iMax < iEnd, 'getDurableSnapshot must Math.max the durations');
  const body = hook.slice(iSnap, iEnd);
  assert.match(body, /committedThroughMsRef\.current/);
  assert.match(body, /durableLiveRef\.current\.capturedDurationMs/);
});

test('validateStashedAudio drops a durable slot whose recovered AAC is gone', async () => {
  const mgr = await read('src/lib/stashAudioManager.ts');
  const iFn = mgr.indexOf('async validateStashedAudio(');
  const region = mgr.slice(iFn, iFn + 2400);
  assert.match(region, /const durableStale =\s*!!slot\.durable\?\.recoveredAudioUri && !fileExists\(slot\.durable\.recoveredAudioUri\)/);
  assert.match(region, /const keptDurable = durableStale \? null : slot\.durable;/);
  assert.match(region, /durable: keptDurable,/);
  // Retained durable pointer keeps its authoritative duration (not segment-sum 0).
  assert.match(region, /audioDuration: keptDurable\s*\?\s*keptDurable\.durationMs \/ 1000/);
});

test('a superseded durable recovery scan cannot mutate storage', async () => {
  const scan = await read('src/lib/durableAudio/durableRecovery.ts');
  // scanDurableRecoveries takes an isCancelled predicate and bails before each
  // mutating side effect; runDurableRecoveryScan passes the generation check.
  assert.match(scan, /isCancelled: \(\) => boolean = \(\) => false/);
  const guards = scan.match(/if \(isCancelled\(\)\) return \[\];/g) || [];
  assert.ok(guards.length >= 3, 'isCancelled must guard reconcile, stash-mid-crash delete, and selfHeal');
  assert.match(scan, /scanDurableRecoveries\(userId, \(\) => myGeneration !== scanGeneration\)/);
});

test('draft detail delete discards durable native audio before clearing metadata', async () => {
  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');
  const iMut = detail.indexOf('const deleteMutation = useMutation(');
  const iDiscard = detail.indexOf('durableRecorder.discard({ userId: user.id, recordingId: rid })', iMut);
  const iDelete = detail.indexOf('await draftStorage.deleteDraft(draftLocalSlotId)', iMut);
  assert.ok(iDiscard > iMut && iDiscard < iDelete, 'detail delete must discard durable audio before deleteDraft');
});

test('iOS durable resume rejects an active capture + an edited recording', async () => {
  const swift = await read('modules/captivet-durable-recorder/ios/DurableRecorderEngine.swift');
  const iResume = swift.indexOf('func resume(userId: String, recordingId: String)');
  const iEnd = swift.indexOf('func stop(', iResume);
  const body = swift.slice(iResume, iEnd);
  // Active-capture guard (mirrors start() + Android busy guard).
  assert.match(body, /if currentRecordingId != nil,\s*\(currentState == "recording" \|\| currentState == "starting"\) \{\s*throw fail\(\.busy/);
  // Edited-recording guard (parity with Android EDITED).
  assert.match(body, /if manifest\.edited == true \{\s*throw fail\(\.state, "cannot resume an edited recording"/);
});

test('JS durable resume is re-entrancy-guarded and treats BUSY as a no-op', async () => {
  const hook = await read('src/hooks/useAudioRecorder.ts');
  assert.match(hook, /const resumeInFlightRef = useRef\(false\)/);
  const iResume = hook.indexOf('const resume = useCallback(');
  const iEnd = hook.indexOf('recorder.record();', iResume);
  const body = hook.slice(iResume, iEnd);
  assert.match(body, /if \(resumeInFlightRef\.current\) return;/);
  assert.match(body, /resumeInFlightRef\.current = true;/);
  // A BUSY rejection must NOT fall through to the graceful-stop path, and the
  // matcher must catch BOTH iOS ("BUSY") and Android ("ERR_DURABLE_BUSY") codes.
  assert.match(body, /\/BUSY\/\.test\(codeStr\) \|\| \/\\bBUSY\\b\/\.test\(String\(error\)\)/);
  assert.match(body, /resumeInFlightRef\.current = false;/);
});

test('durable pause/resume native calls are bounded by a timeout', async () => {
  const hook = await read('src/hooks/useAudioRecorder.ts');
  assert.match(hook, /const DURABLE_PAUSE_TIMEOUT_MS =/);
  assert.match(hook, /const DURABLE_RESUME_TIMEOUT_MS =/);
  assert.match(hook, /function withDurableTimeout<T>/);
  assert.match(hook, /withDurableTimeout\(\s*durableRecorder\.pause\(\),\s*DURABLE_PAUSE_TIMEOUT_MS/);
  assert.match(hook, /withDurableTimeout\(\s*durableRecorder\.resume\(\{ userId, recordingId \}\),\s*DURABLE_RESUME_TIMEOUT_MS/);
});

test('durable self-heal verifies draft deletion before purging audio', async () => {
  const rec = await read('src/lib/durableAudio/durableRecovery.ts');
  const iFn = rec.indexOf('async function selfHeal(');
  const iPurge = rec.indexOf('purgeAfterUpload({ userId, recordingId })', iFn);
  const iVerify = rec.indexOf('const still = await draftStorage.getDraft(manifest.slotId)', iFn);
  assert.ok(iVerify > iFn && iVerify < iPurge, 'selfHeal must verify getDraft===null before purge');
  assert.match(rec.slice(iFn, iPurge), /let draftDeleted = await confirmDraftGone\(\);/);
});

test('durable offline draft-create uses a deterministic idempotency anchor', async () => {
  // syncPending hands the full draft (not just formData) so the durable branch can
  // key on the recordingId; a random key would strand the row -> duplicate on Submit.
  const store = await read('src/lib/draftStorage.ts');
  assert.match(store, /createFn: \(draft: DraftMetadata\) => Promise<\{ id: string \}>/);
  assert.match(store, /const created = await createFn\(draft\);/);
  const pending = await read('src/hooks/usePendingDraftSync.ts');
  assert.match(pending, /idempotencyKey: durableUploadIdempotencyKey\(durableRecordingId\)/);
  assert.match(pending, /setServerRecordingId\(\{ userId, recordingId: durableRecordingId, serverRecordingId: created\.id \}\)/);
  const rec = await read('app/(app)/(tabs)/record.tsx');
  assert.match(rec, /idempotencyKey: durableUploadIdempotencyKey\(durableRecordingId\)/);
});

test('durable active-pointer write is bounded so a hung Keystore cannot strand start', async () => {
  const rec = await read('app/(app)/(tabs)/record.tsx');
  assert.match(rec, /function raceDurableActiveWrite/);
  assert.match(rec, /const DURABLE_ACTIVE_WRITE_TIMEOUT_MS =/);
  // The timeout RESOLVES (setTimeout(resolve, ...)) so start always proceeds.
  assert.match(rec, /timer = setTimeout\(resolve, DURABLE_ACTIVE_WRITE_TIMEOUT_MS\)/);
  assert.match(rec, /await raceDurableActiveWrite\(\s*durableActiveStore\.setActive\(/);
});

test('resumeSession counts missing durable audio in the all-missing prune check', async () => {
  const useStash = await read('src/hooks/useStashedSessions.ts');
  assert.match(useStash, /const totalDurableRecovered = stash\.slots\.reduce\(/);
  assert.match(useStash, /s\.durable\?\.recoveredAudioUri \? 1 : 0/);
  assert.match(useStash, /const allMissing = missingCount === totalSegments \+ totalDurableRecovered;/);
});

test('iOS focus GAIN (.ended) is not emitted as a fatal interruption', async () => {
  const swift = await read('modules/captivet-durable-recorder/ios/DurableRecorderEngine.swift');
  const iEnded = swift.indexOf('case .ended:');
  const iDefault = swift.indexOf('@unknown default:', iEnded);
  const body = swift.slice(iEnded, iDefault);
  // The .ended branch must NOT emit a focus_gain interruption (resume is JS/AppState-driven).
  assert.doesNotMatch(body, /emit\("interruption"/);
  assert.doesNotMatch(swift, /"reason": "focus_gain"/);
  // JS defense-in-depth: the durable interruption listener ignores a gain reason.
  const hook = await read('src/hooks/useAudioRecorder.ts');
  assert.match(hook, /if \(reason === 'focus_gain' \|\| reason === 'gain'\) return;/);
});

test('iOS resume closes the previous writer before replacing it', async () => {
  const swift = await read('modules/captivet-durable-recorder/ios/DurableRecorderEngine.swift');
  const iResume = swift.indexOf('func resume(userId: String, recordingId: String)');
  const iAssign = swift.indexOf('self.writer = w', iResume);
  const iClose = swift.indexOf('self.writer?.close()', iResume);
  assert.ok(iClose > iResume && iClose < iAssign, 'resume must close the old writer before assigning the new one');
});

test('background persister includes finished durable slots', async () => {
  const rec = await read('app/(app)/(tabs)/record.tsx');
  const iPersist = rec.indexOf('const slotsToPersist = sessionRef.current.slots.filter(');
  const body = rec.slice(iPersist, iPersist + 200);
  assert.match(body, /slotHasRecoverableAudio\(slot\) && slot\.uploadStatus !== 'success'/);
});

test('detail-page durable delete spares stash-shared audio and fails CLOSED', async () => {
  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');
  const iMut = detail.indexOf('const deleteMutation = useMutation(');
  const iStrict = detail.indexOf('stashStorage.getStashedSessionsStrict()', iMut);
  const iDiscard = detail.indexOf('durableRecorder.discard({ userId: user.id, recordingId: rid })', iMut);
  assert.ok(iStrict > iMut && iStrict < iDiscard, 'must strict-read stashes before discarding');
  const region = detail.slice(iMut, iDiscard + 60);
  // A read failure must NOT discard (fail closed).
  assert.match(region, /catch \{\s*safeToDiscard = false;/);
  assert.match(region, /if \(safeToDiscard\) \{/);
  // stashStorage exposes the strict (re-throwing) read.
  const stash = await read('src/lib/stashStorage.ts');
  assert.match(stash, /async getStashedSessionsStrict\(\): Promise<StashedSession\[\]>/);
  assert.match(stash, /if \(throwOnError\) throw e;/);
});

test('vault restore cleans up copied durable audio when saveDraft fails', async () => {
  const vault = await read('src/lib/supportStaffRecoveryVault.ts');
  assert.match(vault, /const copiedDurableUris: string\[\] = \[\];/);
  assert.match(vault, /copiedDurableUris\.push\(stableUri\);/);
  const iCatch = vault.indexOf('await Promise.all(restoredSlotIds.map((slotId) => draftStorage.deleteDraft(slotId)');
  assert.match(vault.slice(iCatch, iCatch + 600), /for \(const uri of copiedDurableUris\) safeDeleteFile\(uri\);/);
});
