import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('regenerate SOAP handles 202/empty responses by skipping JSON parsing', async () => {
  const recordingsApi = await read('src/api/recordings.ts');
  assert.match(recordingsApi, /async regenerateSoap\([^)]*\)[^{]*Promise<void>/s);
  assert.match(recordingsApi, /parseJson:\s*false/);

  const client = await read('src/api/client.ts');
  assert.match(client, /parseJson\?: boolean/);
  assert.match(client, /response\.status === 204 \|\| !parseJson/);

  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');
  const regenerateBlock = detail.match(/const regenerateMutation = useMutation\(\{[\s\S]*?\n  \}\);/);
  assert.ok(regenerateBlock, 'regenerate mutation should exist');
  assert.match(regenerateBlock[0], /onSuccess:\s*\(\)\s*=>/);
  assert.doesNotMatch(regenerateBlock[0], /updatedRecording/);
  assert.doesNotMatch(regenerateBlock[0], /setQueryData/);
});

test('custom translation language is not sent raw to analytics', async () => {
  const source = await read('src/components/TranslationCard.tsx');
  assert.match(source, /function analyticsLanguage/);
  assert.match(source, /target_language:\s*analyticsLanguage\(languageValue\)/);
  assert.doesNotMatch(source, /target_language:\s*targetLanguage/);
});

test('translation card sends server-supported ISO language codes', async () => {
  const source = await read('src/components/TranslationCard.tsx');
  const analytics = await read('src/lib/analytics.ts');

  for (const code of ['es', 'fr', 'pt-BR', 'pt-PT', 'de', 'ja', 'ko', 'zh', 'zh-TW', 'vi', 'ar', 'ru', 'it', 'nl', 'th', 'tl', 'hi']) {
    assert.match(source, new RegExp(`value: '${code}'`));
  }
  assert.match(source, /Select/);
  assert.doesNotMatch(source, /__custom__/);
  assert.doesNotMatch(source, /TextInputField/);
  assert.match(analytics, /TranslationTargetLanguage = 'Spanish' \| 'French' \| 'Portuguese' \| 'custom'/);
});

test('translate and email draft use long-running request timeouts', async () => {
  const api = await read('src/api/recordings.ts');

  assert.match(api, /GENERATIVE_REQUEST_TIMEOUT_MS = 90_000/);
  const translateBlock = api.match(/async translate\([\s\S]*?\n  \},\n\n  async generateEmailDraft/);
  assert.ok(translateBlock, 'translate wrapper should exist');
  assert.match(translateBlock[0], /timeoutMs:\s*GENERATIVE_REQUEST_TIMEOUT_MS/);

  const emailBlock = api.match(/async generateEmailDraft\([\s\S]*?\n  \},\n\};/);
  assert.ok(emailBlock, 'email draft wrapper should exist');
  assert.match(emailBlock[0], /timeoutMs:\s*GENERATIVE_REQUEST_TIMEOUT_MS/);
});

test('validation and playback permission errors use actionable copy', async () => {
  const client = await read('src/api/client.ts');
  const strings = await read('src/constants/strings.ts');
  const player = await read('src/components/RecordingAudioPlayer.tsx');

  assert.match(client, /status === 400 && details\.length/);
  assert.match(strings, /forbidden: 'Only the recording author or an admin can play this audio\.'/);
  assert.match(player, /errorCode === 'PLAYBACK_FORBIDDEN'/);
  assert.match(player, /AUDIO_PLAYER_COPY\.forbidden/);
});

test('new Phase 2 fallback strings are centralized', async () => {
  const strings = await read('src/constants/strings.ts');
  for (const key of ['copyFailed', 'shareFailed', 'pdfFailed', 'markFailed']) {
    assert.match(strings, new RegExp(`${key}:`));
  }
  assert.match(strings, /failed: 'Could not generate email draft\.'/);
  assert.doesNotMatch(strings, /enterLanguage/);

  const clientEmail = await read('src/components/ClientEmailCard.tsx');
  assert.doesNotMatch(clientEmail, /'Could not generate email draft\.'/);
  assert.doesNotMatch(clientEmail, /setStatus\('Copy failed\.'\)/);
  assert.doesNotMatch(clientEmail, /setStatus\('Share failed\.'\)/);

  const exportSheet = await read('src/components/ExportSheet.tsx');
  assert.doesNotMatch(exportSheet, /'PDF export failed\.'/);
  assert.doesNotMatch(exportSheet, /'Export failed\.'/);

  const translation = await read('src/components/TranslationCard.tsx');
  assert.doesNotMatch(translation, /TRANSLATION_COPY\.enterLanguage/);
  assert.doesNotMatch(translation, /'Enter a target language\.'/);
  assert.doesNotMatch(translation, /'Translation failed\.'/);
});

test('translation and email draft hide timeout text but preserve ApiError messages', async () => {
  const translation = await read('src/components/TranslationCard.tsx');
  const clientEmail = await read('src/components/ClientEmailCard.tsx');

  assert.match(translation, /import \{ ApiError \} from '..\/api\/client';/);
  assert.match(translation, /error instanceof ApiError \? error\.message : TRANSLATION_COPY\.failed/);
  assert.doesNotMatch(translation, /error instanceof Error \? error\.message/);

  assert.match(clientEmail, /import \{ ApiError \} from '..\/api\/client';/);
  assert.match(clientEmail, /error instanceof ApiError \? error\.message : CLIENT_EMAIL_COPY\.failed/);
  assert.doesNotMatch(clientEmail, /error instanceof Error \? error\.message/);
});

test('export sheet shows the Chrome-extension PIMS hint inside the PIMS disclosure', async () => {
  const strings = await read('src/constants/strings.ts');
  assert.match(
    strings,
    /chromeExtensionHint:\s*\n?\s*'The Captivet Chrome extension sends SOAP notes straight into your PIMS from your browser\.'/
  );

  const exportSheet = await read('src/components/ExportSheet.tsx');
  assert.match(exportSheet, /EXPORT_COPY\.chromeExtensionHint/);
  assert.match(exportSheet, /numberOfLines=\{2\}/);

  // The hint must live inside the showPims disclosure, after the PIMS target buttons.
  const showPimsIdx = exportSheet.indexOf('{showPims && (');
  const targetsIdx = exportSheet.indexOf('PIMS_TARGETS.map');
  const hintIdx = exportSheet.indexOf('EXPORT_COPY.chromeExtensionHint');
  assert.ok(showPimsIdx !== -1, 'showPims disclosure should exist');
  assert.ok(
    showPimsIdx < targetsIdx && targetsIdx < hintIdx,
    'hint should render inside the PIMS disclosure, after the PIMS target buttons'
  );
});

test('playback permission denial does not render retry action', async () => {
  const player = await read('src/components/RecordingAudioPlayer.tsx');

  assert.match(player, /const canRetry = errorCode !== 'PLAYBACK_FORBIDDEN';/);
  assert.match(player, /\{canRetry && \(/);
  assert.match(player, /AUDIO_PLAYER_COPY\.retry/);
});
