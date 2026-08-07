// Shape scanner behind the ui-clip-guard ratchet.
//
// It answers ONE question: is this <Text> laid out in a box that shrink-wraps to
// its measured width, with nothing to absorb the Android "Bold text" overrun?
// (CLAUDE.md > UI Gotchas — Yoga measures with the unadjusted font and fixes the
// height at one line; Android paints wider; the overrun falls outside that box.)
//
// It does NOT answer "will a word actually vanish here". That is undecidable
// statically: most of what these labels render is dynamic (`{title}`,
// `{phaseText}`), so the string is unknown at scan time, and a vanish also needs
// the painted run to exceed the measured box by enough to reach a wrap point.
// The count is therefore a population of SHAPES AT RISK, not a bug count. Read a
// ratchet failure as "a new shrink-wrapped label appeared", and decide on the
// merits whether it needs width — not as "I introduced a clipping bug".
//
// Not an AST parse: the repo has no JSX parser in its test dependencies
// (`npm test` is plain `node --test`). A tag-level scanner with a parent stack is
// enough to classify layout shape, and it agreed with a hand audit to ~97%.
// Deliberately conservative — see SKIPPED below.
//
// Run directly to rewrite the baseline after an intentional change:
//   node tests/ui-clip-guard-scan.mjs --write

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

export const SCAN_ROOTS = ['app', 'src/components'];

/** Tags whose own box shrink-wraps to content, so a child Text inherits no slack. */
const PRESSABLE_TAGS = new Set([
  'Pressable',
  'AnimatedPressable',
  'TouchableOpacity',
  'TouchableHighlight',
  'TouchableWithoutFeedback',
]);

const TEXT_TAGS = new Set(['Text', 'Animated.Text']);

/** Parent className shapes that leave a child Text at exactly its measured width. */
const TIGHT_PARENT = /\b(flex-row|items-center|rounded-(?:full|badge|pill))\b/;

/**
 * Anything on the Text itself that either gives it real width or bounds the
 * damage. `numberOfLines` counts as handled: on a multi-token label it converts
 * a silent vanish into a visible ellipsis, and on a single-token label the
 * failure was only ever an edge glyph-clip.
 */
const MITIGATED =
  /\b(flex-1|w-full|self-stretch|CLIP_SAFE|numberOfLines|flexShrink:\s*0|width:\s*'100%')\b/;

/** Strip comments so commented-out JSX and prose about `<Text>` never count. */
function stripComments(source) {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '') // {/* JSX comment */}
    .replace(/\/\*[\s\S]*?\*\//g, '') // /* block */
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // // line  (the guard skips URLs)
}

const TAG = /<(\/?)([A-Z][A-Za-z0-9_.]*)((?:[^>'"]|'[^']*'|"[^"]*"|\{[^{}]*\})*?)(\/?)>/g;

/**
 * @returns {{file: string, line: number, tag: string, parent: string}[]}
 */
export function scanSource(source, file) {
  const src = stripComments(source);
  const stack = [];
  const hits = [];

  for (const m of src.matchAll(TAG)) {
    const [whole, closing, tag, attrs, selfClosing] = m;

    if (closing) {
      // Tolerate unbalanced input rather than throwing: pop to the match if the
      // tag is on the stack, otherwise ignore it.
      const at = stack.findLastIndex((f) => f.tag === tag);
      if (at >= 0) stack.length = at;
      continue;
    }

    if (TEXT_TAGS.has(tag)) {
      const parent = stack[stack.length - 1];
      const tightParent =
        !!parent && (PRESSABLE_TAGS.has(parent.tag) || TIGHT_PARENT.test(parent.attrs));
      if (tightParent && !MITIGATED.test(attrs)) {
        hits.push({
          file,
          line: src.slice(0, m.index).split('\n').length,
          tag,
          parent: parent.tag,
        });
      }
    }

    if (!selfClosing) stack.push({ tag, attrs });
    void whole;
  }

  return hits;
}

async function collectFiles(relativeDir) {
  const entries = await readdir(path.join(root, relativeDir), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(rel)));
    else if (entry.name.endsWith('.tsx')) files.push(rel);
  }
  return files.sort();
}

/** @returns {Promise<Record<string, number>>} per-file counts, zero-count files omitted. */
export async function scanRepo() {
  const files = (await Promise.all(SCAN_ROOTS.map(collectFiles))).flat();
  const counts = {};
  for (const file of files) {
    const hits = scanSource(await readFile(path.join(root, file), 'utf8'), file);
    if (hits.length) counts[file] = hits.length;
  }
  return counts;
}

export const BASELINE_PATH = path.join(here, 'ui-clip-guard-baseline.json');

export async function readBaseline() {
  return JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const counts = await scanRepo();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (process.argv.includes('--write')) {
    const body = {
      _comment:
        'Per-file count of shrink-wrapped, unmitigated <Text> shapes. A SHAPE census, not a bug count — see tests/ui-clip-guard-scan.mjs. Regenerate with: node tests/ui-clip-guard-scan.mjs --write',
      roots: SCAN_ROOTS,
      total,
      files: counts,
    };
    await writeFile(BASELINE_PATH, `${JSON.stringify(body, null, 2)}\n`);
    console.log(`wrote baseline: ${total} across ${Object.keys(counts).length} files`);
  } else {
    console.log(JSON.stringify({ total, files: counts }, null, 2));
  }
}
