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
  if (text.length <= CHUNK_THRESHOLD_CHARS) return [{ text, startsSourceParagraph: true }];
  const paragraphs = text.split(/\n{2,}/);
  if (paragraphs.length > 1) {
    const chunks = [];
    let current = '';
    let currentStartsParagraph = true;
    for (const para of paragraphs) {
      let firstPieceOfPara = true;
      for (const piece of splitOversizedRun(para)) {
        const sep = firstPieceOfPara ? '\n\n' : ' ';
        firstPieceOfPara = false;
        if (current.length + piece.length > FALLBACK_CHUNK_CHARS && current) {
          chunks.push({ text: current, startsSourceParagraph: currentStartsParagraph });
          current = piece;
          currentStartsParagraph = sep === '\n\n';
        } else {
          current = current ? `${current}${sep}${piece}` : piece;
        }
      }
    }
    if (current) chunks.push({ text: current, startsSourceParagraph: currentStartsParagraph });
    return chunks;
  }
  return accumulateWithSpaces(text.split(/(?<=[.!?])\s+/).flatMap(hardSplitOversized)).map(
    (t, i) => ({ text: t, startsSourceParagraph: i === 0 })
  );
}

function splitOversizedRun(run) {
  if (run.length <= FALLBACK_CHUNK_CHARS) return [run];
  return accumulateWithSpaces(run.split(/(?<=[.!?])\s+/).flatMap(hardSplitOversized));
}

function accumulateWithSpaces(pieces) {
  const out = [];
  let current = '';
  for (const piece of pieces) {
    if (current.length + piece.length > FALLBACK_CHUNK_CHARS && current) {
      out.push(current);
      current = piece;
    } else {
      current = current ? `${current} ${piece}` : piece;
    }
  }
  if (current) out.push(current);
  return out;
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
  assert.deepEqual(chunkTranscript(short), [{ text: short, startsSourceParagraph: true }]);
  assert.deepEqual(chunkTranscript(''), [{ text: '', startsSourceParagraph: true }]);
});

test('paragraph transcripts chunk on blank lines without content loss', () => {
  const para = 'Sentence one. Sentence two.';
  const text = Array.from({ length: 400 }, (_, i) => `${para} #${i}`).join('\n\n');
  assert.ok(text.length > CHUNK_THRESHOLD_CHARS);
  const result = chunkTranscript(text);
  const chunks = result.map((c) => c.text);
  assert.ok(chunks.length > 1, 'expected multiple chunks');
  assert.equal(chunks.join('\n\n'), text, 'paragraph join must round-trip');
  // Small paragraphs only — every chunk starts at a source blank line.
  assert.ok(result.every((c) => c.startsSourceParagraph));
  for (const chunk of chunks) {
    assert.ok(chunk.length <= FALLBACK_CHUNK_CHARS + para.length + 8, 'chunks stay near the target size');
  }
});

test('wall-of-text transcripts fall back to sentence chunks without loss', () => {
  const text = Array.from({ length: 500 }, (_, i) => `Sentence number ${i} of the visit.`).join(' ');
  assert.ok(text.length > CHUNK_THRESHOLD_CHARS);
  const result = chunkTranscript(text);
  const chunks = result.map((c) => c.text);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(' '), text, 'sentence join must round-trip');
  // One source paragraph — only the first chunk may claim a boundary.
  assert.ok(result.slice(1).every((c) => !c.startsSourceParagraph));
});

test('punctuation-less walls of text still hard-split (Codex P2, PR #143)', () => {
  // Degraded speech-to-text: no blank lines, no sentence punctuation at all.
  const text = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(' ');
  assert.ok(text.length > CHUNK_THRESHOLD_CHARS);
  const chunks = chunkTranscript(text).map((c) => c.text);
  assert.ok(chunks.length > 1, 'must not come back as one giant chunk');
  assert.equal(chunks.join(' '), text, 'whitespace hard-split must round-trip');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= FALLBACK_CHUNK_CHARS + 10, `chunk too large: ${chunk.length}`);
  }
});

test('an oversized paragraph is split before accumulation (Codex P2 round 4, PR #143)', () => {
  // Short heading + one 7,500-char punctuation-less STT paragraph: the
  // paragraph branch must not pass the giant paragraph through as one chunk.
  const giantPara = Array.from({ length: 1500 }, (_, i) => `w${i}`).join(' ');
  const text = `Heading.\n\n${giantPara}`;
  assert.ok(text.length > CHUNK_THRESHOLD_CHARS);
  const chunks = chunkTranscript(text).map((c) => c.text);
  assert.ok(chunks.length > 2, 'giant paragraph must be split');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= FALLBACK_CHUNK_CHARS + 10, `chunk too large: ${chunk.length}`);
  }
  // No content dropped (joins may differ inside the split paragraph).
  assert.equal(
    chunks.join(' ').replace(/\s+/g, ' '),
    text.replace(/\s+/g, ' ')
  );
});

test('sentence spacing preserved inside oversized paragraphs (Codex P2 round 5)', () => {
  // A long PUNCTUATED paragraph must not be rejoined with a blank line after
  // every sentence — '\n\n' belongs only at boundaries present in the source.
  const sentence = 'This is a normal sentence from the visit transcript.';
  const giantPara = Array.from({ length: 150 }, () => sentence).join(' ');
  const text = `Heading.\n\n${giantPara}\n\nFooter.`;
  assert.ok(text.length > CHUNK_THRESHOLD_CHARS);
  const result = chunkTranscript(text);
  const chunks = result.map((c) => c.text);
  assert.ok(chunks.length > 2, 'giant paragraph must be split');
  // Size-split continuation chunks must NOT claim a paragraph boundary —
  // the renderer keys its mt-3 paragraph gap off this flag (Codex P2 round 6).
  const boundaryChunks = result.filter((c) => c.startsSourceParagraph).length;
  assert.ok(boundaryChunks <= 3, `too many boundary chunks: ${boundaryChunks}`);
  const blankLineJoins = chunks
    .map((c) => (c.match(/\n\n/g) ?? []).length)
    .reduce((a, b) => a + b, 0);
  assert.ok(blankLineJoins <= 2, `fake blank lines inserted: ${blankLineJoins}`);
  for (const chunk of chunks) {
    assert.ok(
      chunk.length <= FALLBACK_CHUNK_CHARS + sentence.length + 10,
      `chunk too large: ${chunk.length}`
    );
  }
  assert.equal(
    chunks.join(' ').replace(/\s+/g, ' '),
    text.replace(/\s+/g, ' ')
  );
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
  assert.match(src, /function splitOversizedRun/);
  assert.match(src, /function accumulateWithSpaces/);
  assert.match(src, /\.flatMap\(hardSplitOversized\)/);
  assert.match(src, /splitOversizedRun\(para\)/);
  // '\n\n' only at source paragraph boundaries; split pieces rejoin with ' '.
  assert.match(src, /firstPieceOfPara \? '\\n\\n' : ' '/);
  // The renderer applies the paragraph gap (mt-3) only where the SOURCE had a
  // blank line — size-split continuation chunks carry the flag as false.
  assert.match(src, /startsSourceParagraph: boolean/);
  assert.match(src, /i > 0 && chunk\.startsSourceParagraph \? 'mt-3' : ''/);
  assert.match(src, /chunks\.map\(\(chunk, i\) => \(/);
  assert.match(src, /selectable/);
});
