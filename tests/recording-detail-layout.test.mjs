import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Recording detail reorder (2026-09-02, plan: assess-the-overall-layout-compiled-lagoon,
// tier 2). The SOAP note — the thing a vet opens a recording for — started 2.5
// viewports down, under Reprocess, five task rows, and three tool cards. These
// fences keep the SOAP-first order and the on-demand tools row from drifting back.

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const DETAIL_PATH = 'app/(app)/(tabs)/recordings/[id].tsx';

test('detail screen renders SOAP before tasks, export, and the tools row', async () => {
  const detail = await read(DETAIL_PATH);
  const patientInfo = detail.indexOf('{/* Patient Info */}');
  const soap = detail.indexOf('{/* SOAP Note */}');
  const tasks = detail.indexOf('<SuggestedTasksCard');
  const exportSheet = detail.indexOf('<ExportSheet');
  const tools = detail.indexOf('{/* Tools */}');
  assert.ok(patientInfo > 0 && soap > patientInfo, 'Patient Info precedes SOAP');
  assert.ok(tasks > soap, 'Suggested Tasks follow the SOAP note');
  assert.ok(exportSheet > tasks, 'Export follows Suggested Tasks');
  assert.ok(tools > exportSheet, 'Tools row is last');
});

test('every processing/state card still precedes the SOAP note', async () => {
  const detail = await read(DETAIL_PATH);
  const soap = detail.indexOf('{/* SOAP Note */}');
  for (const anchor of [
    'RECORDING_DETAIL_COPY.processingTitle',
    'retry_scheduled',
    'awaitingMetadataTitle',
    'audioNotOnDeviceTitle',
    'processingFailedTitle',
    'Transcript Quality Warning',
  ]) {
    const at = detail.indexOf(anchor);
    assert.ok(at > 0 && at < soap, `${anchor} must render above the SOAP note`);
  }
});

test('Export renders outside the soapNote branch so the Transcript tab keeps it', async () => {
  const detail = await read(DETAIL_PATH);
  const soapBranch = detail.indexOf('soapNote ? (');
  const soapView = detail.indexOf('<SoapNoteView');
  const exportSheet = detail.indexOf('<ExportSheet');
  assert.ok(soapBranch > 0 && soapView > soapBranch);
  const branch = detail.slice(soapBranch, detail.indexOf('SOAP note not available.'));
  assert.doesNotMatch(branch, /<ExportSheet/, 'ExportSheet must not live inside the soapNote ternary');
  assert.ok(exportSheet > soapView);
  assert.match(detail, /recording\.status === 'completed' && soapNote && recordingPermissions\.canExport && \(/);
});

test('audio-forbidden state is a one-line note under Patient Info, not a card', async () => {
  const detail = await read(DETAIL_PATH);
  const patientInfo = detail.indexOf('{/* Patient Info */}');
  const player = detail.indexOf('<RecordingAudioPlayer');
  const note = detail.indexOf('AUDIO_PLAYER_COPY.forbidden');
  assert.ok(note > patientInfo && note < player, 'note sits between Patient Info and the player');
  const around = detail.slice(note - 400, note);
  assert.doesNotMatch(around, /<Card/, 'the forbidden note is not a Card');
  assert.match(detail, /const showAudioForbiddenNote =\s*!!recording\.audioFileUrl && recording\.status !== 'draft' && !recordingPermissions\.canPlayAudio/);
  // The player ternary keeps its shape (recording-permissions fence) with a null else.
  assert.match(detail, /recordingPermissions\.canPlayAudio \? \([\s\S]*?<RecordingAudioPlayer[\s\S]*?\/>\s*\) : null/);
  assert.doesNotMatch(detail, /AUDIO_PLAYER_COPY\.title/);
});

test('Suggested Tasks is a controlled collapsible with a pending-count badge', async () => {
  const detail = await read(DETAIL_PATH);
  assert.match(detail, /const \[tasksExpanded, setTasksExpanded\] = useState\(false\)/);
  assert.match(detail, /<SuggestedTasksCard[\s\S]*?expanded=\{tasksExpanded\}[\s\S]*?onToggle=\{/);
  const card = stripComments(await read('src/components/SuggestedTasksCard.tsx'));
  assert.match(card, /<Collapsible/);
  assert.match(card, /badge=\{SUGGESTED_TASKS_COPY\.pendingCount\(countSuggestedTasks\(tasks\)\)\}/);
  assert.match(card, /expanded=\{expanded\}/);
  assert.doesNotMatch(card, /LayoutAnimation/);
  // useMutation stays above the early return so accept/dismiss state survives a collapse.
  assert.ok(card.indexOf('useMutation(') < card.indexOf('if (groups.length === 0) return null'));
  const copy = await read('src/constants/strings.ts');
  assert.match(copy, /pendingCount: \(count: number\): string =>/);
  assert.match(copy, /'All reviewed'/);
});

test('tools row gates each chip on the same permission as the card it reveals', async () => {
  const raw = await read(DETAIL_PATH);
  const detail = stripComments(raw);
  // Slice on the raw source: the marker is itself a comment.
  const tools = stripComments(raw.slice(raw.indexOf('{/* Tools */}')));
  assert.match(detail, /type DetailTool = 'email' \| 'translate' \| 'reprocess'/);
  assert.match(detail, /const \[openTools, setOpenTools\] = useState<Set<DetailTool>>/);
  // Multi-open: email drafts and translations are long generative calls; opening
  // one tool must never unmount another's result.
  assert.doesNotMatch(detail, /setOpenTools\(new Set\(\[tool\]\)\)/);
  assert.match(tools, /RECORDING_TOOLS_COPY\.heading/);
  assert.match(tools, /openTools\.has\('email'\) && recording\.status === 'completed' && recordingPermissions\.canExport/);
  assert.match(tools, /openTools\.has\('translate'\) && recording\.status === 'completed' && recordingPermissions\.canCopy/);
  assert.match(tools, /openTools\.has\('reprocess'\) && canReprocess/);
  assert.match(tools, /<ClientEmailCard recordingId=\{id\} \/>/);
  assert.match(tools, /<TranslationCard recordingId=\{id\} \/>/);
  assert.match(tools, /<ReprocessSheet[\s\S]*?defaultExpanded[\s\S]*?onDismiss=\{/);
  assert.match(tools, /onPress=\{openConsultAI\}/);
  // The reprocess gate keeps the literal the recording-retry-state guard greps.
  assert.match(detail, /const canReprocess =[\s\S]*?!!recording\.audioFileUrl &&\s*retryPresentation !== 'audio_unavailable' &&\s*aiModels/);
  assert.doesNotMatch(detail, /ConsultAICard/);
  // Both tool states reset when the route id changes.
  const idEffect = detail.slice(detail.indexOf('setAccessRevoked(null);'), detail.indexOf('}, [id]);'));
  assert.match(idEffect, /setOpenTools\(new Set\(\)\)/);
  assert.match(idEffect, /setTasksExpanded\(false\)/);
});

test('Consult AI is a direct link helper; the card component is gone', async () => {
  const consult = await read('src/lib/consultAi.ts');
  assert.match(consult, /export function openConsultAI\(\): void/);
  assert.match(consult, /Linking\.openURL\(CONSULT_URL\)\.catch\(/);
  assert.match(consult, /CONSULT_COPY\.openFailedTitle, CONSULT_COPY\.openFailedBody/);
  await assert.rejects(read('src/components/ConsultAICard.tsx'), 'ConsultAICard.tsx must be deleted');
});

test('TranslationCard keeps the Select and drops the duplicate quick-language chips', async () => {
  const translation = await read('src/components/TranslationCard.tsx');
  assert.match(translation, /<Select/);
  assert.doesNotMatch(translation, /SegmentedControl|QUICK_LANGUAGE_OPTIONS|isQuickLanguage|quickLanguageValue/);
});

test('ExportSheet PIMS disclosure reads as a button', async () => {
  const exportSheet = await read('src/components/ExportSheet.tsx');
  const button = exportSheet.slice(exportSheet.indexOf('setShowPims((value) => !value)') - 400, exportSheet.indexOf('setShowPims((value) => !value)') + 200);
  assert.match(button, /variant="secondary"/);
  assert.doesNotMatch(button, /variant="ghost"/);
  assert.match(button, /accessibilityState=\{\{ expanded: showPims \}\}/);
});

test('ReprocessSheet can open expanded and reports dismissal', async () => {
  const sheet = await read('src/components/ReprocessSheet.tsx');
  assert.match(sheet, /defaultExpanded\?: boolean/);
  assert.match(sheet, /onDismiss\?: \(\) => void/);
  assert.match(sheet, /useState\(defaultExpanded \?\? false\)/);
  assert.equal((sheet.match(/onDismiss\?\.\(\)/g) ?? []).length, 2, 'success + Cancel both report dismissal');
});
