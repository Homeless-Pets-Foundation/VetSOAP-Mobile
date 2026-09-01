import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTsModule } from './helpers/loadTs.mjs';

const validator = await loadTsModule('src/api/downloadManifest.ts');

const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
const HOST = 'captivet-recordings.0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const RECORDING_ID = '22222222-2222-4222-8222-222222222222';

function signedUrl({
  key = `recordings/${ORG_ID}/${RECORDING_ID}.m4a`,
  filename = `Captivet-recording-2026-09-01-${RECORDING_ID}.m4a`,
  host = HOST,
  date = '20260901T120000Z',
  expires = '1800',
  signature = 'a'.repeat(64),
  credential = 'AKIATEST/20260901/auto/s3/aws4_request',
} = {}) {
  const params = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': credential,
    'X-Amz-Date': date,
    'X-Amz-Expires': expires,
    'X-Amz-SignedHeaders': 'host',
    'X-Amz-Signature': signature,
    'response-content-disposition': `attachment; filename="${filename}"`,
    'x-id': 'GetObject',
  });
  return `https://${host}/${key}?${params}`;
}

function singleManifest(overrides = {}) {
  const filename = `Captivet-recording-2026-09-01-${RECORDING_ID}.m4a`;
  return {
    expiresAt: new Date(NOW + 18 * 60 * 1000).toISOString(),
    totalSizeBytes: 100,
    files: [
      {
        partNumber: 1,
        partCount: 1,
        filename,
        mimeType: 'audio/mp4',
        sizeBytes: 100,
        url: signedUrl({ filename }),
      },
    ],
    ...overrides,
  };
}

function parse(value) {
  return validator.parseDownloadManifest(value, {
    recordingId: RECORDING_ID,
    organizationId: ORG_ID,
    configuredVirtualHost: HOST,
    nowMs: NOW,
  });
}

function reasonOf(fn) {
  try {
    fn();
  } catch (error) {
    return error.reason;
  }
  assert.fail('Expected manifest validation to fail');
}

test('accepts a strict single-file attachment manifest pinned to tenant and recording', () => {
  const manifest = singleManifest();
  assert.deepEqual(parse(manifest), manifest);
});

test('accepts a historical object inside the exact tenant recording directory', () => {
  const value = singleManifest();
  value.files[0].url = signedUrl({
    key: `recordings/${ORG_ID}/${RECORDING_ID}/audio.m4a`,
  });
  assert.deepEqual(parse(value), value);
});

test('accepts ordered multipart originals with exact numbered filenames', () => {
  const files = [0, 1, 2].map((index) => {
    const part = String(index + 1).padStart(2, '0');
    const filename = `Captivet-recording-2026-09-01-${RECORDING_ID}-part-${part}-of-03.m4a`;
    return {
      partNumber: index + 1,
      partCount: 3,
      filename,
      mimeType: 'audio/mp4',
      sizeBytes: index + 1,
      url: signedUrl({
        key: `recordings/${ORG_ID}/${RECORDING_ID}_segment_${index}.m4a`,
        filename,
      }),
    };
  });
  const manifest = singleManifest({ totalSizeBytes: 6, files });
  assert.deepEqual(parse(manifest), manifest);
});

test('rejects unknown response fields, total mismatches, and unordered descriptors', () => {
  assert.equal(reasonOf(() => parse({ ...singleManifest(), extra: true })), 'invalid_response_shape');
  assert.equal(reasonOf(() => parse(singleManifest({ totalSizeBytes: 99 }))), 'total_size_mismatch');
  const unordered = singleManifest();
  unordered.files[0].partNumber = 2;
  assert.equal(reasonOf(() => parse(unordered)), 'invalid_part_order');
});

test('rejects a wrong R2 host, tenant path, recording path, or duplicate object', () => {
  const wrongHost = singleManifest();
  wrongHost.files[0].url = signedUrl({ host: `evil.${HOST}` });
  assert.equal(reasonOf(() => parse(wrongHost)), 'untrusted_r2_target');

  const wrongOrg = singleManifest();
  wrongOrg.files[0].url = signedUrl({
    key: `recordings/33333333-3333-4333-8333-333333333333/${RECORDING_ID}.m4a`,
  });
  assert.equal(reasonOf(() => parse(wrongOrg)), 'wrong_recording_path');

  const wrongRecording = singleManifest();
  wrongRecording.files[0].url = signedUrl({
    key: `recordings/${ORG_ID}/44444444-4444-4444-8444-444444444444.m4a`,
  });
  assert.equal(reasonOf(() => parse(wrongRecording)), 'wrong_recording_path');

  const duplicateFiles = [1, 2].map((partNumber) => {
    const part = String(partNumber).padStart(2, '0');
    const filename = `Captivet-recording-2026-09-01-${RECORDING_ID}-part-${part}-of-02.m4a`;
    return {
      partNumber,
      partCount: 2,
      filename,
      mimeType: 'audio/mp4',
      sizeBytes: 50,
      url: signedUrl({ filename }),
    };
  });
  const duplicateObject = singleManifest({ totalSizeBytes: 100, files: duplicateFiles });
  assert.equal(reasonOf(() => parse(duplicateObject)), 'duplicate_object_path');
});

test('rejects malformed signatures, non-30-minute URLs, stale expiry, and attachment mismatch', () => {
  const signature = singleManifest();
  signature.files[0].url = signedUrl({ signature: 'not-a-signature' });
  assert.equal(reasonOf(() => parse(signature)), 'invalid_signature');

  const credential = singleManifest();
  credential.files[0].url = signedUrl({ credential: 'AKIATEST/not-a-scope' });
  assert.equal(reasonOf(() => parse(credential)), 'invalid_credential');

  const ttl = singleManifest();
  ttl.files[0].url = signedUrl({ expires: '900' });
  assert.equal(reasonOf(() => parse(ttl)), 'invalid_expires');

  const stale = singleManifest({ expiresAt: new Date(NOW + 10_000).toISOString() });
  assert.equal(reasonOf(() => parse(stale)), 'manifest_expired');

  const attachment = singleManifest();
  attachment.files[0].url = signedUrl({ filename: 'Captivet-recording-2026-09-01-wrong.m4a' });
  assert.equal(reasonOf(() => parse(attachment)), 'invalid_attachment_filename');
});

test('rejects unsupported MIME values and MIME/filename extension mismatches', () => {
  const unsupported = singleManifest();
  unsupported.files[0].mimeType = 'audio/x-untrusted';
  assert.equal(reasonOf(() => parse(unsupported)), 'invalid_response_shape');

  const mismatch = singleManifest();
  mismatch.files[0].mimeType = 'audio/webm';
  assert.equal(reasonOf(() => parse(mismatch)), 'mime_extension_mismatch');
});

test('rejects PHI-shaped or invalid-date filenames', () => {
  const phi = singleManifest();
  phi.files[0].filename = `Captivet-recording-2026-09-01-Buddy-${RECORDING_ID}.m4a`;
  assert.equal(reasonOf(() => parse(phi)), 'invalid_filename');

  const badDate = singleManifest();
  badDate.files[0].filename = `Captivet-recording-2026-02-31-${RECORDING_ID}.m4a`;
  badDate.files[0].url = signedUrl({ filename: badDate.files[0].filename });
  assert.equal(reasonOf(() => parse(badDate)), 'invalid_filename_date');
});

test('descriptor comparison permits URL/expiry refresh only', () => {
  const left = parse(singleManifest());
  const refreshedValue = singleManifest({ expiresAt: new Date(NOW + 20 * 60 * 1000).toISOString() });
  refreshedValue.files[0].url = signedUrl({ date: '20260901T120100Z' });
  const right = parse(refreshedValue);
  assert.equal(validator.sameDownloadDescriptors(left, right), true);

  right.files[0].sizeBytes += 1;
  assert.equal(validator.sameDownloadDescriptors(left, right), false);
});

test('descriptor comparison rejects a refreshed URL that swaps the underlying object path', () => {
  const left = parse(singleManifest());
  const swappedValue = singleManifest({
    expiresAt: new Date(NOW + 20 * 60 * 1000).toISOString(),
  });
  swappedValue.files[0].url = signedUrl({
    key: `recordings/${ORG_ID}/${RECORDING_ID}_segment_0.m4a`,
    date: '20260901T120100Z',
  });
  const swapped = parse(swappedValue);

  assert.equal(validator.sameDownloadDescriptors(left, swapped), false);
});
