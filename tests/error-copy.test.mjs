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
