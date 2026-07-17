// WP26 — long transcripts render as per-paragraph chunks (one giant selectable
// Android TextView caused multi-second layout and selection ANRs on clinic
// tablets); short transcripts stay a single Text so whole-transcript
// long-press selection is preserved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Mirror of chunkTranscript in src/components/TranscriptView.tsx (structural
// assertion below keeps the mirror honest).
const CHUNK_THRESHOLD_CHARS = 6_000;
const FALLBACK_CHUNK_CHARS = 1_500;
function chunkTranscript(text) {
  if (text.length <= CHUNK_THRESHOLD_CHARS) return [text];
  const paragraphs = text.split(/\n{2,}/);
  if (paragraphs.length > 1) {
    const chunks = [];
    let current = '';
    for (const para of paragraphs) {
      if (current.length + para.length > FALLBACK_CHUNK_CHARS && current) {
        chunks.push(current);
        current = para;
      } else {
        current = current ? `${current}\n\n${para}` : para;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }
  const sentences = text.split(/(?<=[.!?])\s+/).flatMap(hardSplitOversized);
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if (current.length + sentence.length > FALLBACK_CHUNK_CHARS && current) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function hardSplitOversized(piece) {
  if (piece.length <= FALLBACK_CHUNK_CHARS) return [piece];
  const words = piece.split(/\s+/);
  const out = [];
  let current = '';
  for (const word of words) {
    if (word.length > FALLBACK_CHUNK_CHARS) {
      if (current) {
        out.push(current);
        current = '';
      }
      for (let i = 0; i < word.length; i += FALLBACK_CHUNK_CHARS) {
        out.push(word.slice(i, i + FALLBACK_CHUNK_CHARS));
      }
      continue;
    }
    if (current.length + word.length + 1 > FALLBACK_CHUNK_CHARS && current) {
      out.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) out.push(current);
  return out;
}

test('short transcripts stay a single chunk (whole-text selection preserved)', () => {
  const short = 'S: Bella presented for annual wellness.\n\nO: BAR, BCS 5/9.';
  assert.deepEqual(chunkTranscript(short), [short]);
  assert.deepEqual(chunkTranscript(''), ['']);
});

test('paragraph transcripts chunk on blank lines without content loss', () => {
  const para = 'Sentence one. Sentence two.';
  const text = Array.from({ length: 400 }, (_, i) => `${para} #${i}`).join('\n\n');
  assert.ok(text.length > CHUNK_THRESHOLD_CHARS);
  const chunks = chunkTranscript(text);
  assert.ok(chunks.length > 1, 'expected multiple chunks');
  assert.equal(chunks.join('\n\n'), text, 'paragraph join must round-trip');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= FALLBACK_CHUNK_CHARS + para.length + 8, 'chunks stay near the target size');
  }
});

test('wall-of-text transcripts fall back to sentence chunks without loss', () => {
  const text = Array.from({ length: 500 }, (_, i) => `Sentence number ${i} of the visit.`).join(' ');
  assert.ok(text.length > CHUNK_THRESHOLD_CHARS);
  const chunks = chunkTranscript(text);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(' '), text, 'sentence join must round-trip');
});

test('punctuation-less walls of text still hard-split (Codex P2, PR #143)', () => {
  // Degraded speech-to-text: no blank lines, no sentence punctuation at all.
  const text = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(' ');
  assert.ok(text.length > CHUNK_THRESHOLD_CHARS);
  const chunks = chunkTranscript(text);
  assert.ok(chunks.length > 1, 'must not come back as one giant chunk');
  assert.equal(chunks.join(' '), text, 'whitespace hard-split must round-trip');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= FALLBACK_CHUNK_CHARS + 10, `chunk too large: ${chunk.length}`);
  }
});

test('a single unbroken token gets sliced at hard char boundaries', () => {
  const text = 'x'.repeat(7000);
  const chunks = chunkTranscript(text);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), text, 'char slicing must preserve every character');
});

test('source component matches this mirror and renders per-chunk selectable Text', async () => {
  const src = await readFile(path.join(root, 'src/components/TranscriptView.tsx'), 'utf8');
  assert.match(src, /const CHUNK_THRESHOLD_CHARS = 6_000;/);
  assert.match(src, /const FALLBACK_CHUNK_CHARS = 1_500;/);
  assert.match(src, /export function chunkTranscript/);
  assert.match(src, /function hardSplitOversized/);
  assert.match(src, /\.flatMap\(hardSplitOversized\)/);
  assert.match(src, /chunks\.map\(\(chunk, i\) => \(/);
  assert.match(src, /selectable/);
});
