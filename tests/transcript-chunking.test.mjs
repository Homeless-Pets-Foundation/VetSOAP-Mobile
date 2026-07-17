// WP26 — long transcripts render as multiple sibling Text chunks (one giant
// selectable Android TextView caused multi-second layout and selection ANRs on
// clinic tablets); short transcripts stay a single Text so whole-transcript
// long-press selection is preserved. Round 13 (Codex P2): chunking is
// whitespace-preserving — inner whitespace is reproduced verbatim and
// boundaries only fall at existing newline runs.
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
  if (text.length <= CHUNK_THRESHOLD_CHARS) return [{ text, startsSourceParagraph: true }];
  const tokens = text.split(/(\n+)/);
  const chunks = [];
  let current = '';
  let startsParagraph = true;
  const flush = () => {
    if (current.length > 0) {
      chunks.push({ text: current, startsSourceParagraph: startsParagraph });
      current = '';
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (i % 2 === 1) {
      if (current.length + token.length <= FALLBACK_CHUNK_CHARS) {
        current += token;
      } else {
        flush();
        startsParagraph = token.length >= 2;
      }
      continue;
    }
    const pieces = token.length > FALLBACK_CHUNK_CHARS ? hardSplitOversized(token) : [token];
    for (const piece of pieces) {
      if (current.length > 0 && current.length + piece.length > FALLBACK_CHUNK_CHARS) {
        flush();
        startsParagraph = false;
      }
      current += piece;
    }
  }
  flush();
  return chunks;
}

function hardSplitOversized(line) {
  if (line.length <= FALLBACK_CHUNK_CHARS) return [line];
  const out = [];
  let pos = 0;
  while (pos < line.length) {
    if (line.length - pos <= FALLBACK_CHUNK_CHARS) {
      out.push(line.slice(pos));
      break;
    }
    const window = line.slice(pos, pos + FALLBACK_CHUNK_CHARS);
    const lastSpace = window.lastIndexOf(' ');
    const cut = lastSpace > 0 ? lastSpace + 1 : window.length;
    out.push(line.slice(pos, pos + cut));
    pos += cut;
  }
  return out;
}

// No NON-whitespace content is lost or added (boundary newline runs are the
// only chars a chunk boundary may drop, and those are whitespace).
function assertContentPreserved(chunks, text) {
  assert.equal(
    chunks.map((c) => c.text).join('').replace(/\s+/g, ''),
    text.replace(/\s+/g, ''),
    'no non-whitespace character may be lost or added'
  );
}

test('short transcripts stay a single chunk (whole-text selection preserved)', () => {
  const short = 'S: Bella presented for annual wellness.\n\nO: BAR, BCS 5/9.';
  assert.deepEqual(chunkTranscript(short), [{ text: short, startsSourceParagraph: true }]);
  assert.deepEqual(chunkTranscript(''), [{ text: '', startsSourceParagraph: true }]);
});

test('paragraph transcripts chunk on blank lines, preserving inner blank lines', () => {
  const para = 'Sentence one. Sentence two.';
  const text = Array.from({ length: 400 }, (_, i) => `${para} #${i}`).join('\n\n');
  assert.ok(text.length > CHUNK_THRESHOLD_CHARS);
  const result = chunkTranscript(text);
  assert.ok(result.length > 1, 'expected multiple chunks');
  assertContentPreserved(result, text);
  // Blank-line paragraph breaks are kept VERBATIM inside chunks (not collapsed).
  assert.ok(result.some((c) => c.text.includes('\n\n')), 'inner blank lines preserved');
  for (const c of result) {
    assert.ok(c.text.length <= FALLBACK_CHUNK_CHARS + para.length + 8, 'chunks stay near target size');
  }
});

test('single-newline speaker turns are preserved, not collapsed to spaces (Codex P2 round 13)', () => {
  // Wall of text delimited by SINGLE newlines (speaker turns / section labels),
  // no blank lines — the old sentence-split collapsed these to spaces.
  const text = Array.from({ length: 400 }, (_, i) => `Speaker ${i}: says a sentence here.`).join('\n');
  assert.ok(text.length > CHUNK_THRESHOLD_CHARS);
  const result = chunkTranscript(text);
  assert.ok(result.length > 1);
  assertContentPreserved(result, text);
  // The newlines survive INSIDE chunks — they are not turned into prose.
  assert.ok(result.some((c) => c.text.includes('\n')), 'speaker-turn newlines preserved');
  // A consumed single-newline boundary is not a paragraph start (no mt-3).
  assert.ok(result.slice(1).every((c) => c.startsSourceParagraph === false));
});

test('repeated spaces inside a line are preserved verbatim', () => {
  // A line with irregular spacing, padded past the threshold with paragraphs.
  const spaced = 'Temp:    101.2F     HR:   90     RR:   24';
  const filler = Array.from({ length: 800 }, (_, i) => `clinical note number ${i}`).join('\n\n');
  const text = `${spaced}\n\n${filler}`;
  assert.ok(text.length > CHUNK_THRESHOLD_CHARS);
  const result = chunkTranscript(text);
  // The exact multi-space run appears verbatim in some chunk.
  assert.ok(result.some((c) => c.text.includes('Temp:    101.2F     HR:   90     RR:   24')));
  assertContentPreserved(result, text);
});

test('an oversized single line is sliced without dropping characters', () => {
  // One 8,000-char line of space-separated words, no newlines.
  const text = Array.from({ length: 1400 }, (_, i) => `word${i}`).join(' ');
  assert.ok(text.length > CHUNK_THRESHOLD_CHARS);
  const chunks = chunkTranscript(text).map((c) => c.text);
  assert.ok(chunks.length > 1, 'must not come back as one giant chunk');
  // Slice-based hard split keeps the space with the preceding piece → exact.
  assert.equal(chunks.join(''), text, 'slice split must preserve every character');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= FALLBACK_CHUNK_CHARS + 1, `chunk too large: ${chunk.length}`);
  }
});

test('a single unbroken token gets sliced at hard char boundaries', () => {
  const text = 'x'.repeat(7000);
  const chunks = chunkTranscript(text).map((c) => c.text);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), text, 'char slicing must preserve every character');
});

test('source component matches this mirror and renders per-chunk selectable Text', async () => {
  const src = await readFile(path.join(root, 'src/components/TranscriptView.tsx'), 'utf8');
  assert.match(src, /const CHUNK_THRESHOLD_CHARS = 6_000;/);
  assert.match(src, /const FALLBACK_CHUNK_CHARS = 1_500;/);
  assert.match(src, /export function chunkTranscript/);
  assert.match(src, /function hardSplitOversized/);
  // Whitespace-preserving tokenizer + newline-boundary chunking.
  assert.match(src, /text\.split\(\/\(\\n\+\)\/\)/);
  assert.match(src, /startsParagraph = token\.length >= 2;/);
  // Slice-based hard split (no split-and-rejoin that collapses whitespace).
  assert.match(src, /const lastSpace = window\.lastIndexOf\(' '\);/);
  assert.doesNotMatch(src, /function accumulateWithSpaces/);
  assert.doesNotMatch(src, /function splitOversizedRun/);
  // Renderer applies mt-3 only at source paragraph boundaries.
  assert.match(src, /startsSourceParagraph: boolean/);
  assert.match(src, /i > 0 && chunk\.startsSourceParagraph \? 'mt-3' : ''/);
  assert.match(src, /chunks\.map\(\(chunk, i\) => \(/);
  assert.match(src, /selectable/);
});
