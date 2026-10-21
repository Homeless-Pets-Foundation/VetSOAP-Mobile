// Every static className token must generate CSS. NativeWind silently drops a
// class it can't resolve, so a typo or a token that never existed renders as
// React Native's defaults with nothing to notice: `text-heading-lg` (not in the
// fontSize scale) left four auth-screen titles at 14px — smaller than the body
// text under them — and `border-border-subtle` drew a default black hairline.
// The other guards (theme-token, dark-mode, ui-clip) fence patterns; none asks
// whether a class exists at all.
//
// Method: Tailwind's own context (project config + nativewind preset) answers
// `getClassOrder(token)` with null for anything it cannot generate. Tokens are
// collected from STATIC string literals in `*ClassName=` attributes only —
// interpolated fragments are skipped rather than guessed. Classes global.css
// defines by hand (any layer) count as valid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOTS = ['app', 'src']; // tailwind.config.js `content`
const SOURCE_EXT = /\.(ts|tsx)$/;

// Tokens that are valid but invisible to the Tailwind context. Keep each one
// justified; an entry here is a claim that NativeWind resolves the token.
const ALLOWLIST = new Map([]);

/**
 * Classes global.css defines by hand, in any layer (`@layer components`:
 * screen, card…; `@layer utilities`: the bg-/text-/border-status-* pairs).
 */
function cssDefinedClasses() {
  const css = readFileSync(path.join(repoRoot, 'global.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const names = new Set();
  for (const m of css.matchAll(/(^|[\s,{}])\.([A-Za-z_][\w-]*)/g)) names.add(m[2]);
  return names;
}

function listSources() {
  const files = [];
  for (const root of SOURCE_ROOTS) {
    for (const rel of readdirSync(path.join(repoRoot, root), { recursive: true })) {
      if (SOURCE_EXT.test(rel)) files.push(path.join(root, rel));
    }
  }
  return files.sort();
}

/** Index just past the string/template literal starting at `i` (src[i] is the quote). */
function skipLiteral(src, i) {
  const quote = src[i];
  i += 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (quote === '`' && c === '$' && src[i + 1] === '{') {
      i = skipBalanced(src, i + 1);
      continue;
    }
    if (c === quote) return i + 1;
    i += 1;
  }
  return i;
}

/** Index just past the `{…}` group starting at `i` (src[i] === '{'). */
function skipBalanced(src, i) {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      i = skipLiteral(src, i);
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return i;
}

const COMPARISON_BEFORE = /(===|!==|==|!=)\s*$/;
const COMPARISON_AFTER = /^\s*(===|!==|==|!=)/;

/**
 * Static class-list strings inside an expression: string literals that are not
 * comparison operands, and the static chunks of template literals. A chunk
 * token touching an interpolation (`bg-${x}`) is partial and dropped.
 * Returns [{ text, offset }] with offsets relative to `expr`.
 */
function staticStrings(expr) {
  const out = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === '"' || c === "'") {
      const end = skipLiteral(expr, i);
      const before = expr.slice(0, i);
      const after = expr.slice(end);
      if (!COMPARISON_BEFORE.test(before) && !COMPARISON_AFTER.test(after)) {
        out.push({ text: expr.slice(i + 1, end - 1), offset: i + 1 });
      }
      i = end;
      continue;
    }
    if (c === '`') {
      const end = skipLiteral(expr, i);
      const body = expr.slice(i + 1, end - 1);
      let j = 0;
      let chunkStart = 0;
      const pushChunk = (from, to, touchesLeft, touchesRight) => {
        let chunk = body.slice(from, to);
        // Drop a token glued to an interpolation on either side.
        if (touchesLeft) chunk = chunk.replace(/^\S+/, '');
        if (touchesRight) chunk = chunk.replace(/\S+$/, '');
        out.push({ text: chunk, offset: i + 1 + from });
      };
      let leftTouch = false;
      while (j < body.length) {
        if (body[j] === '\\') {
          j += 2;
          continue;
        }
        if (body[j] === '$' && body[j + 1] === '{') {
          pushChunk(chunkStart, j, leftTouch, true);
          const close = skipBalanced(body, j + 1);
          // Literals inside the interpolation (`${on ? 'a' : 'b'}`) are static too.
          for (const inner of staticStrings(body.slice(j + 2, close - 1))) {
            out.push({ text: inner.text, offset: i + 1 + j + 2 + inner.offset });
          }
          j = close;
          chunkStart = j;
          leftTouch = true;
          continue;
        }
        j += 1;
      }
      pushChunk(chunkStart, body.length, leftTouch, false);
      i = end;
      continue;
    }
    i += 1;
  }
  return out;
}

/** [{ file, line, token }] for every static className token in the sources. */
function collectTokens() {
  const found = [];
  for (const file of listSources()) {
    const src = readFileSync(path.join(repoRoot, file), 'utf8');
    const attrRe = /\b[A-Za-z]*[cC]lassName\s*=\s*/g;
    let m;
    while ((m = attrRe.exec(src))) {
      const at = m.index + m[0].length;
      let strings = [];
      if (src[at] === '"' || src[at] === "'") {
        const end = skipLiteral(src, at);
        strings = [{ text: src.slice(at + 1, end - 1), offset: at + 1 }];
      } else if (src[at] === '{') {
        const end = skipBalanced(src, at);
        strings = staticStrings(src.slice(at + 1, end - 1)).map((s) => ({
          text: s.text,
          offset: at + 1 + s.offset,
        }));
      } else {
        continue;
      }
      for (const s of strings) {
        const line = src.slice(0, s.offset).split('\n').length;
        for (const token of s.text.split(/\s+/)) {
          if (token) found.push({ file, line, token });
        }
      }
    }
  }
  return found;
}

function unknownTokens() {
  const resolveConfig = require('tailwindcss/resolveConfig');
  const { createContext } = require('tailwindcss/lib/lib/setupContextUtils');
  const context = createContext(resolveConfig(require(path.join(repoRoot, 'tailwind.config.js'))));
  const cssClasses = cssDefinedClasses();
  const occurrences = collectTokens();
  const unique = [...new Set(occurrences.map((o) => o.token))];
  const known = new Set(
    context
      .getClassOrder(unique)
      .filter(([, order]) => order !== null)
      .map(([name]) => name),
  );
  const isValid = (token) => known.has(token) || cssClasses.has(token) || ALLOWLIST.has(token);
  return {
    occurrences,
    unknown: occurrences.filter((o) => !isValid(o.token)),
  };
}

test('every static className token generates CSS', () => {
  const { occurrences, unknown } = unknownTokens();
  assert.ok(occurrences.length > 1000, `scanner found only ${occurrences.length} tokens — extraction broke`);
  assert.deepEqual(
    unknown.map((u) => `${u.file}:${u.line} ${u.token}`),
    [],
    'these className tokens generate no CSS (NativeWind drops them silently). Use a real token from tailwind.config.js, a global.css component class, or justify an ALLOWLIST entry.',
  );
});

test('the scanner sees through cx(), ternaries and template literals', () => {
  // A probe against the extractor itself, so a parser regression can't pass
  // the main test by collecting nothing.
  const expr = "cx('flex-1 px-4', on ? 'bg-surface' : 'bg-surface-raised', size === 'sm' && 'h-8') + `gap-2 bg-${x} ${y ? 'mt-2' : 'mt-4'}`";
  const tokens = staticStrings(expr).flatMap((s) => s.text.split(/\s+/)).filter(Boolean);
  assert.deepEqual(
    tokens.sort(),
    ['bg-surface', 'bg-surface-raised', 'flex-1', 'gap-2', 'h-8', 'mt-2', 'mt-4', 'px-4'].sort(),
  );
});

test('hand-written global.css classes are recognised', () => {
  const cssClasses = cssDefinedClasses();
  for (const name of ['screen', 'card', 'bg-status-warning', 'text-status-danger']) {
    assert.ok(cssClasses.has(name), `${name} missing from: ${[...cssClasses].join(', ')}`);
  }
  assert.ok(!cssClasses.has('root'), 'only class selectors, not pseudo-classes');
});
