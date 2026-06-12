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
  let source;
  try {
    source = await read(path);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      assert.fail(`${path} should exist and export executable helpers`);
    }
    throw error;
  }

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
  });
  return module.exports;
}

const markdown = await loadTsModule('src/lib/markdown.ts');
const { parseMarkdownBlocks, toPlainText, parseSpans } = markdown;

// Objects built inside the vm realm have a foreign Object.prototype, which
// deepStrictEqual rejects — normalize through JSON before comparing.
const j = (value) => JSON.parse(JSON.stringify(value));

test('parseSpans splits bold and plain runs, unpaired ** stays literal', () => {
  assert.deepEqual(j(parseSpans('plain text')), [{ text: 'plain text', bold: false }]);
  assert.deepEqual(j(parseSpans('**Weight**: 30kg')), [
    { text: 'Weight', bold: true },
    { text: ': 30kg', bold: false },
  ]);
  assert.deepEqual(j(parseSpans('a **b** c **d**')), [
    { text: 'a ', bold: false },
    { text: 'b', bold: true },
    { text: ' c ', bold: false },
    { text: 'd', bold: true },
  ]);
  // Unpaired/empty markers must not vanish or throw.
  assert.deepEqual(j(parseSpans('lonely ** marker')), [{ text: 'lonely ** marker', bold: false }]);
  assert.deepEqual(j(parseSpans('****')), [{ text: '****', bold: false }]);
  assert.deepEqual(j(parseSpans('')), [{ text: '', bold: false }]);
});

test('parseMarkdownBlocks handles headers, bullets, numbered lists, paragraphs', () => {
  const blocks = parseMarkdownBlocks(
    [
      '# Assessment',
      '## Differentials',
      'First paragraph line one',
      'line two',
      '',
      'Second paragraph',
      '- dash bullet',
      '* star bullet',
      '1. first item',
      '2) second item',
    ].join('\n')
  );

  assert.deepEqual(
    j(blocks.map((b) => b.type)),
    ['header', 'header', 'paragraph', 'paragraph', 'bullet', 'bullet', 'numbered', 'numbered']
  );
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[1].level, 2);
  // Consecutive plain lines merge into one paragraph with the newline kept.
  assert.deepEqual(j(blocks[2].spans), [{ text: 'First paragraph line one\nline two', bold: false }]);
  assert.deepEqual(j(blocks[4].spans), [{ text: 'dash bullet', bold: false }]);
  assert.deepEqual(j(blocks[5].spans), [{ text: 'star bullet', bold: false }]);
  assert.equal(blocks[6].marker, '1.');
  assert.equal(blocks[7].marker, '2.');
});

test('parseMarkdownBlocks does not mistake leading **bold** for a star bullet', () => {
  const blocks = parseMarkdownBlocks('**Plan**: recheck in 2 weeks');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'paragraph');
  assert.deepEqual(j(blocks[0].spans[0]), { text: 'Plan', bold: true });
});

test('parseMarkdownBlocks survives malformed and hostile input', () => {
  assert.deepEqual(j(parseMarkdownBlocks('')), []);
  assert.deepEqual(j(parseMarkdownBlocks('   \n\n  ')), []);
  // ###+ clamps to level 2; never throws.
  assert.equal(parseMarkdownBlocks('#### deep header')[0].level, 2);
  // Non-string input coerces instead of throwing (defensive: API data is untyped at runtime).
  assert.equal(parseMarkdownBlocks(null).length, 0);
  assert.equal(parseMarkdownBlocks(undefined).length, 0);
  const big = '**b** normal\n- item\n'.repeat(2000);
  assert.ok(parseMarkdownBlocks(big).length > 0);
});

test('toPlainText strips markers so pasted notes carry no markdown', () => {
  const input = [
    '# Subjective',
    'Owner reports **lethargy** for 3 days.',
    '',
    '- gave **2 tablets**',
    '* star bullet',
    '1. first',
  ].join('\n');
  assert.equal(
    toPlainText(input),
    ['Subjective', 'Owner reports lethargy for 3 days.', '', '- gave 2 tablets', '- star bullet', '1. first'].join(
      '\n'
    )
  );
  // Idempotent on already-plain text.
  const plain = 'Plain note with 5 mg/kg dose.\n\nSecond paragraph.';
  assert.equal(toPlainText(plain), plain);
  // Unpaired markers stay literal rather than corrupting text.
  assert.equal(toPlainText('lonely ** marker'), 'lonely ** marker');
});

test('MarkdownText component falls back to raw text and gates console.error', async () => {
  const component = await read('src/components/MarkdownText.tsx');
  assert.match(component, /try\s*{\s*blocks = parseMarkdownBlocks/);
  assert.match(component, /if \(__DEV__\) console\.error/);
  // Fallback path renders the raw string.
  assert.match(component, /if \(!blocks\)/);
});

test('SoapNoteView renders through MarkdownText and copies plain text', async () => {
  const view = await read('src/components/SoapNoteView.tsx');
  assert.match(view, /<MarkdownText text=\{content \?\? ''\}/);
  assert.match(view, /copyWithAutoClear\(toPlainText\(content \?\? ''\)\)/);
  assert.match(view, /toPlainText\(section\?\.content \?\? ''\)/);
});
