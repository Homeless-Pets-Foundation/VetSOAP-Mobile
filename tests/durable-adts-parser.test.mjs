import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import ts from 'typescript';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const requireForVm = createRequire(import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), 'utf8');
}

async function loadTsModule(path) {
  const source = await read(path);
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      strict: true,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require: requireForVm,
    Error,
    TypeError,
    RangeError,
    Uint8Array,
    ArrayBuffer,
    Math,
    Number,
    console,
  });
  return module.exports;
}

// AAC sampling-frequency index table (subset used in tests).
const SF_INDEX = { 16000: 8, 24000: 8 /*unused*/, 44100: 4, 48000: 3 };
const SF_INDEX_24K = 6;

// Build one ADTS frame: 7-byte header (no CRC) + payload of `payloadLen` bytes.
function adtsFrame({ sampleRateIndex = 8, channels = 1, profileMinus1 = 1, payloadLen = 100, fill = 0x2a } = {}) {
  const headerLen = 7;
  const frameLen = headerLen + payloadLen;
  const b = new Uint8Array(frameLen);
  b[0] = 0xff;
  b[1] = 0xf1; // sync low nibble + MPEG-4 + layer 00 + protection_absent=1
  b[2] = ((profileMinus1 & 3) << 6) | ((sampleRateIndex & 0xf) << 2) | ((channels >> 2) & 1);
  b[3] = ((channels & 3) << 6) | ((frameLen >> 11) & 3);
  b[4] = (frameLen >> 3) & 0xff;
  b[5] = ((frameLen & 7) << 5) | 0x1f; // buffer fullness high bits = 0x7FF
  b[6] = (0x3f << 2) | 0; // buffer fullness low + num_raw_data_blocks 0
  for (let i = headerLen; i < frameLen; i++) b[i] = fill;
  return b;
}

function concat(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

const MODULE = 'src/lib/durableAudio/adts.ts';

test('parses N complete frames, derives count/bytes/format/duration', async () => {
  const { parseAdts } = await loadTsModule(MODULE);
  const f = () => adtsFrame({ sampleRateIndex: SF_INDEX[16000], channels: 1, payloadLen: 50 });
  const frames = [f(), f(), f()];
  const buf = concat(...frames);
  const r = parseAdts(buf);
  assert.equal(r.frameCount, 3);
  assert.equal(r.completeFrameBytes, buf.length);
  assert.equal(r.sampleRate, 16000);
  assert.equal(r.channels, 1);
  assert.equal(r.malformed, false);
  assert.equal(r.truncatedFinal, false);
  // 3 frames * 1024 samples / 16000 Hz * 1000 = 192ms
  assert.equal(r.durationMs, 192);
});

test('truncated final frame: recover valid prefix, flag truncatedFinal', async () => {
  const { parseAdts } = await loadTsModule(MODULE);
  const good = adtsFrame({ payloadLen: 40 });
  const partial = adtsFrame({ payloadLen: 40 }).slice(0, 20); // cut mid-frame
  const buf = concat(good, good, partial);
  const r = parseAdts(buf);
  assert.equal(r.frameCount, 2);
  assert.equal(r.completeFrameBytes, good.length * 2);
  assert.equal(r.truncatedFinal, true);
  assert.equal(r.malformed, false);
});

test('malformed frame before EOF: recover prefix, flag malformed, no forward scan', async () => {
  const { parseAdts } = await loadTsModule(MODULE);
  const good = adtsFrame({ payloadLen: 40 });
  const garbage = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
  const laterGood = adtsFrame({ payloadLen: 40 });
  const buf = concat(good, garbage, laterGood);
  const r = parseAdts(buf);
  assert.equal(r.frameCount, 1); // stops at garbage, does NOT scan forward to laterGood
  assert.equal(r.completeFrameBytes, good.length);
  assert.equal(r.malformed, true);
});

test('empty / sub-header buffer => zero recoverable frames', async () => {
  const { parseAdts } = await loadTsModule(MODULE);
  assert.equal(parseAdts(new Uint8Array(0)).frameCount, 0);
  assert.equal(parseAdts(new Uint8Array([0xff, 0xf1])).frameCount, 0);
});

test('garbage from byte 0 => malformed, zero frames', async () => {
  const { parseAdts } = await loadTsModule(MODULE);
  const buf = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const r = parseAdts(buf);
  assert.equal(r.frameCount, 0);
  assert.equal(r.completeFrameBytes, 0);
  assert.equal(r.malformed, true);
});

test('mid-file sample-rate drift: stop at drift boundary, flag malformed', async () => {
  const { parseAdts } = await loadTsModule(MODULE);
  const a = adtsFrame({ sampleRateIndex: SF_INDEX[16000], payloadLen: 40 });
  const drift = adtsFrame({ sampleRateIndex: SF_INDEX[44100], payloadLen: 40 });
  const buf = concat(a, a, drift);
  const r = parseAdts(buf);
  assert.equal(r.frameCount, 2);
  assert.equal(r.completeFrameBytes, a.length * 2);
  assert.equal(r.sampleRate, 16000); // locked at first frame
  assert.equal(r.malformed, true);
});

test('mid-file channel drift: stop at drift boundary', async () => {
  const { parseAdts } = await loadTsModule(MODULE);
  const a = adtsFrame({ channels: 1, payloadLen: 40 });
  const drift = adtsFrame({ channels: 2, payloadLen: 40 });
  const buf = concat(a, drift);
  const r = parseAdts(buf);
  assert.equal(r.frameCount, 1);
  assert.equal(r.channels, 1);
  assert.equal(r.malformed, true);
});

test('baseOffset: completeFrameBytes is absolute (tail-seek support)', async () => {
  const { parseAdts } = await loadTsModule(MODULE);
  const f = adtsFrame({ payloadLen: 40 });
  const buf = concat(f, f);
  const base = 100000;
  const r = parseAdts(buf, { baseOffset: base });
  assert.equal(r.completeFrameBytes, base + buf.length);
  assert.equal(r.frameCount, 2);
});

test('24kHz fallback profile parses with correct rate/duration', async () => {
  const { parseAdts } = await loadTsModule(MODULE);
  const f = () => adtsFrame({ sampleRateIndex: SF_INDEX_24K, payloadLen: 30 });
  const buf = concat(f(), f(), f());
  const r = parseAdts(buf);
  assert.equal(r.sampleRate, 24000);
  assert.equal(r.frameCount, 3);
  // 3 * 1024 / 24000 * 1000 = 128ms
  assert.equal(r.durationMs, 128);
});

test('framesToDurationMs helper matches frame-derived duration', async () => {
  const { framesToDurationMs } = await loadTsModule(MODULE);
  assert.equal(framesToDurationMs(3, 16000), 192);
  assert.equal(framesToDurationMs(0, 16000), 0);
});
