// WP16 — friendlyErrorMessage maps errors to safe copy by status/code/type
// only (never server-message pattern matching). Mirrors src/lib/errorCopy.ts;
// the structural assertions keep the mirror honest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFile(path.join(root, rel), 'utf8');

test('errorCopy branches only on ApiError status/code and error type', async () => {
  const src = await read('src/lib/errorCopy.ts');
  assert.match(src, /error\.status === 0/);
  assert.match(src, /error\.status === 429/);
  assert.match(src, /error\.status >= 500/);
  assert.match(src, /error instanceof TypeError/);
  // No server-message pattern matching (Monitoring rules).
  assert.ok(!/error\.message\.(includes|match)/.test(src), 'must not branch on server message text');
  assert.match(src, /technicalErrorDetails/);
  assert.match(src, /\.slice\(0, 512\)/);
});

test('display sites route through the mapper, raw detail via clipboard only', async () => {
  const home = await read('app/(app)/(tabs)/index.tsx');
  assert.match(home, /friendlyErrorMessage\(error, 'load'\)/);
  assert.match(home, /copyWithAutoClear\(technicalErrorDetails\(error\)\)/);
  assert.ok(!home.includes('] {error.message}'), 'home must not render raw error.message');

  const detail = await read('app/(app)/(tabs)/recordings/[id].tsx');
  assert.match(detail, /ERROR_COPY\.processingFailedBody/);
  assert.ok(!detail.includes('errorMessage.slice(0, 200)'), 'detail must not render truncated raw server error');
  assert.match(detail, /copyWithAutoClear\(recording\.errorMessage \?\? ''\)/);

  const record = await read('app/(app)/(tabs)/record.tsx');
  assert.match(record, /getUploadPhase\(error\) !== 'unknown'/);
  assert.match(record, /friendlyErrorMessage\(error, 'upload'\)/);
});

test('a 409 maps to conflict copy in both the mapper and the API message builder', async () => {
  // Before this branch existed every 409 — typed or untyped — reached the vet as
  // ERROR_COPY.uploadGeneric / loadFailed via the mapper, and as
  // 'Something went wrong. Please try again.' via buildErrorMessage
  // (Sentry REACT-NATIVE-1Z: a 409 on POST /api/recordings).
  const src = await read('src/lib/errorCopy.ts');
  assert.match(src, /error\.status === 409/);
  // Context-aware: recording wording on the upload path, neutral elsewhere. A
  // 409 from device registration or a settings route must not tell the vet to
  // go check Recordings.
  assert.match(src, /context === 'upload' \? ERROR_COPY\.conflictRecording : ERROR_COPY\.conflict/);

  const strings = await read('src/constants/strings.ts');
  assert.match(strings, /conflict:\s*\n?\s*'This was already updated on the server/);
  assert.match(strings, /conflictRecording:\s*\n?\s*'This recording was already updated on the server/);
  assert.match(strings, /conflictAlreadySubmitted:/);

  // The API layer needs its own branch: ApiError.message is what reaches Sentry
  // and the clipboard, and the mapper never sees it.
  const client = await read('src/api/client.ts');
  assert.match(client, /if \(status === 409\) \{/);
  assert.match(client, /errorBody\.code === 'IDEMPOTENCY_KEY_MISMATCH'/);
  // Single source of truth: the API layer imports the catalog rather than
  // duplicating the sentences, so the two surfaces cannot drift apart.
  assert.match(client, /import \{ ERROR_COPY \} from '\.\.\/constants\/strings'/);
  assert.match(client, /endpointKindOf\(path\) === 'recordings'/);
  assert.ok(!/'This recording was already updated on the server/.test(client),
    'client.ts must not carry its own copy of the conflict sentence');
  // Status/code only — the mapper guard above already forbids message matching.
  assert.ok(!/status === 409[\s\S]{0,400}errorBody\.error/.test(client),
    'a 409 must not echo raw server text');
});
