// WP11 — OS text scaling is capped at 1.3x, never disabled. Disabling scaling
// froze 12–15px text for low-vision users on exactly the dense screens (SOAP
// actions, audio player, status badges) where they most need it. Per-element
// SMALLER caps are allowed; disabling is not, and neither is exceeding 1.3x.
//
// This guard used to assert only that three source strings existed in
// app/_layout.tsx. That patched `Text.render` / `TextInput.render`, and RN 0.83
// exports both as plain function components with no `.render` static — so the
// patch never ran and the cap was never applied. A physical-device measurement
// on 2026-08-25 found text scaling 3.58x against a declared 1.3x cap while this
// test was green. A source grep cannot observe that the code it fences never
// executes, so the guard is now two things that can actually fail:
//
//   1. the cap resolver is EXECUTED, not grepped;
//   2. an import fence proves every call site routes through the wrapper that
//      applies it, so a new file cannot silently opt out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadTsModule } from './helpers/loadTs.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The single file allowed to import Text/TextInput from react-native. */
const WRAPPER = 'src/components/ui/Text.tsx';

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* walk(full);
    } else if (/\.tsx?$/.test(entry.name)) {
      yield full;
    }
  }
}

test('no allowFontScaling={false} anywhere in app/ or src/', async () => {
  const offenders = [];
  for (const dir of ['app', 'src']) {
    for await (const file of walk(path.join(root, dir))) {
      const src = await readFile(file, 'utf8');
      if (src.includes('allowFontScaling={false}')) {
        offenders.push(path.relative(root, file));
      }
    }
  }
  assert.deepEqual(offenders, [], `allowFontScaling={false} found in: ${offenders.join(', ')}`);
});

test('the cap resolver defaults to 1.3x', async () => {
  const { resolveMaxFontSizeMultiplier, GLOBAL_MAX_FONT_SIZE_MULTIPLIER } =
    await loadTsModule('src/lib/fontScaling.ts');
  assert.equal(GLOBAL_MAX_FONT_SIZE_MULTIPLIER, 1.3);
  assert.equal(resolveMaxFontSizeMultiplier(undefined), 1.3);
});

test('the cap resolver honours a smaller per-element cap', async () => {
  const { resolveMaxFontSizeMultiplier } = await loadTsModule('src/lib/fontScaling.ts');
  assert.equal(resolveMaxFontSizeMultiplier(1.1), 1.1);
});

test('the cap resolver clamps a larger per-element cap to the global cap', async () => {
  // A per-element value above 1.3 is the overflow this cap exists to prevent
  // (the Home device-capacity banner ran off its card at 3.58x). Smaller wins;
  // larger does not.
  const { resolveMaxFontSizeMultiplier } = await loadTsModule('src/lib/fontScaling.ts');
  assert.equal(resolveMaxFontSizeMultiplier(2), 1.3);
});

test('the cap resolver rejects disabling scaling via a nonsense cap', async () => {
  const { resolveMaxFontSizeMultiplier } = await loadTsModule('src/lib/fontScaling.ts');
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(resolveMaxFontSizeMultiplier(bad), 1.3, `bad cap ${bad} should fall back to 1.3`);
  }
});

test('only the ui/Text wrapper imports Text or TextInput from react-native', async () => {
  // The fence. Without it the wrapper is advisory: one new file importing Text
  // straight from react-native silently opts 1.3x out again, exactly the way
  // the old render patch failed.
  const offenders = [];
  for (const dir of ['app', 'src']) {
    for await (const file of walk(path.join(root, dir))) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      if (rel === WRAPPER) continue;
      const src = await readFile(file, 'utf8');
      for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'react-native'/g)) {
        const named = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim());
        if (named.includes('Text') || named.includes('TextInput')) offenders.push(rel);
      }
    }
  }
  assert.deepEqual(
    [...new Set(offenders)].sort(),
    [],
    `Text/TextInput imported from react-native outside ${WRAPPER}: ${[...new Set(offenders)].sort().join(', ')}`,
  );
});

test('the wrapper applies the resolved cap to both Text and TextInput', async () => {
  const src = await readFile(path.join(root, WRAPPER), 'utf8');
  // Both components must be wrapped, and the cap must be resolved per call
  // rather than hardcoded, so a smaller per-element cap still wins.
  assert.match(src, /export function Text\b/);
  assert.match(src, /export const TextInput = React\.forwardRef/);
  // `useRef<TextInput>` in app/(auth)/login.tsx needs TextInput in the TYPE
  // namespace too; without this alias the fence would force that call site back
  // to importing from react-native.
  assert.match(src, /export type TextInput = RNTextInput/);
  const applied = src.match(/maxFontSizeMultiplier=\{resolveMaxFontSizeMultiplier\(maxFontSizeMultiplier\)\}/g);
  assert.equal(applied?.length, 2, 'both Text and TextInput must apply the resolved cap');
});

test('the dead Text.render patch is gone from app/_layout.tsx', async () => {
  // RN 0.83 has no .render static on Text/TextInput; the patch silently no-oped.
  // Keeping it would leave a second, non-functioning source of truth for the cap.
  const src = await readFile(path.join(root, 'app/_layout.tsx'), 'utf8');
  assert.doesNotMatch(src, /__interApplied/);
  assert.doesNotMatch(src, /GLOBAL_MAX_FONT_SIZE_MULTIPLIER/);
  assert.doesNotMatch(src, /target\.render/);
});

// ---------------------------------------------------------------------------
// App typeface. Inter is embedded by the expo-font plugin and applied by the
// same wrapper that applies the cap. It previously rode on the dead
// Text.render patch and therefore never rendered at all, so these assertions
// check the whole chain — constant, embedded file, plugin registration, and
// the wrapper actually using it — rather than any one link.
// ---------------------------------------------------------------------------

/** Read name-table entries from a TTF/OTF so the test reads the REAL family name. */
async function readFontNames(relPath) {
  const buf = await readFile(path.join(root, relPath));
  const numTables = buf.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const p = 12 + i * 16;
    tables[buf.toString('ascii', p, p + 4)] = buf.readUInt32BE(p + 8);
  }
  const off = tables.name;
  const count = buf.readUInt16BE(off + 2);
  const strOff = buf.readUInt16BE(off + 4);
  const names = {};
  for (let i = 0; i < count; i++) {
    const p = off + 6 + i * 12;
    const platformId = buf.readUInt16BE(p);
    const nameId = buf.readUInt16BE(p + 6);
    const len = buf.readUInt16BE(p + 8);
    const strO = buf.readUInt16BE(p + 10);
    const raw = buf.subarray(off + strOff + strO, off + strOff + strO + len);
    if (names[nameId] !== undefined) continue;
    if (platformId === 3) {
      // Windows platform strings are UTF-16BE; Node only decodes LE, so swap.
      const swapped = Buffer.from(raw);
      swapped.swap16();
      names[nameId] = swapped.toString('utf16le');
    } else {
      names[nameId] = raw.toString('latin1');
    }
  }
  return { names, hasVariableAxes: tables.fvar !== undefined };
}

test('the app font family name matches the embedded font file', async () => {
  // If someone swaps the TTF for one whose family differs, `fontFamily: 'Inter'`
  // silently resolves to the system font — the exact class of silent failure
  // this whole guard exists for.
  const { APP_FONT_FAMILY, APP_FONT_ASSET } = await loadTsModule('src/lib/typography.ts');
  const buf = await readFile(path.join(root, APP_FONT_ASSET));
  assert.ok(buf.length > 0, `${APP_FONT_ASSET} is missing or empty`);
  const { names, hasVariableAxes } = await readFontNames(APP_FONT_ASSET);
  const family = (names[1] || '').replace(/[^\x20-\x7E]/g, '');
  assert.equal(family, APP_FONT_FAMILY, `embedded font family is "${family}", wrapper asks for "${APP_FONT_FAMILY}"`);
  // The weights the app uses (font-medium/semibold/bold, 174 call sites) come
  // from the variable wght axis; a static Regular-only file would collapse them.
  assert.ok(hasVariableAxes, 'embedded font has no fvar table — weights would collapse');
});

test('the font FILENAME stem matches the family name (Android resolves by filename)', async () => {
  // Android does not read the font's internal name table. expo-font enumerates
  // `assets/fonts/` with ^(.+?)(_bold|_italic|_bold_italic)?\.(ttf|otf)$ and RN's
  // ReactFontManager resolves `fontFamily: "X"` to `fonts/X.ttf`. So a file named
  // Inter-Variable.ttf registers as "Inter-Variable" and `fontFamily: 'Inter'`
  // falls back to Roboto — SILENTLY, and only on Android, while iOS (which uses
  // the internal family name) renders Inter correctly. Verified on an emulator.
  const { APP_FONT_FAMILY, APP_FONT_ASSET } = await loadTsModule('src/lib/typography.ts');
  const stem = path.basename(APP_FONT_ASSET).replace(/\.(ttf|otf)$/, '');
  assert.equal(
    stem,
    APP_FONT_FAMILY,
    `font file must be named ${APP_FONT_FAMILY}.ttf for Android to resolve it; found ${stem}`,
  );
});

test('app.config.ts registers the embedded font with expo-font', async () => {
  const { APP_FONT_ASSET } = await loadTsModule('src/lib/typography.ts');
  const config = await readFile(path.join(root, 'app.config.ts'), 'utf8');
  assert.ok(
    config.includes(`./${APP_FONT_ASSET}`),
    `app.config.ts must pass ./${APP_FONT_ASSET} to the expo-font plugin`,
  );
});

test('the ui/Text wrapper applies the app font family', async () => {
  const src = await readFile(path.join(root, WRAPPER), 'utf8');
  assert.match(src, /APP_FONT_FAMILY/);
  // Base-first: the app font is the FALLBACK layer, so any explicit per-element
  // fontFamily (and NativeWind className styles) still win.
  const applied = src.match(/style=\{\[\{ fontFamily: APP_FONT_FAMILY \}, style\]\}/g);
  assert.equal(applied?.length, 2, 'both Text and TextInput must apply the app font, base-first');
});

// ---------------------------------------------------------------------------
// Framework-rendered text. The wrapper fence above proves every string WE
// render routes through `src/components/ui/Text.tsx`. It says nothing about
// strings a NAVIGATOR renders for us: React Navigation builds the bottom-tab
// labels from the `title` screen options itself, so they never touch the
// wrapper and, before this guard, stayed in the system font while every screen
// switched to Inter. The framework's supported hook is the label style option,
// which is merged after the navigation theme's own `fonts.*` entry.
// ---------------------------------------------------------------------------

/** Navigator options whose value styles text the framework renders for us. */
const FRAMEWORK_TEXT_STYLE_OPTIONS = [
  'tabBarLabelStyle',
  'tabBarBadgeStyle',
  'headerTitleStyle',
  'headerBackTitleStyle',
  'headerLargeTitleStyle',
  'drawerLabelStyle',
];

/**
 * Blank out comments and string/template bodies, preserving offsets and line
 * breaks. Brace-balancing the RAW source would count a `{` written inside a
 * comment or a string, which does not just mis-slice — it can run the slice on
 * past the real closing brace and swallow a later `APP_FONT_FAMILY` from
 * somewhere else in the file, passing a style that never set the family. A
 * guard that can report green while the thing it fences is broken is the exact
 * failure this file was rewritten to stop, so it must not be reintroduced in
 * the guard's own helper.
 *
 * A template body is blanked whole, `${...}` included, so an interpolation's
 * braces are removed in matched pairs and the balance is preserved. Regex
 * literals are not tracked; one containing an apostrophe or an unmatched brace
 * would mis-mask, which breaks the balance and fails the test loudly rather
 * than passing it quietly.
 */
function maskNonCode(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let i = from; i < to; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') j += 2;
        else if (src[j] === c) break;
        else j++;
      }
      blank(i + 1, Math.min(j, src.length));
      i = Math.min(j + 1, src.length);
    } else {
      i++;
    }
  }
  return out.join('');
}

/** Extract the balanced `{...}` object literal that follows `key:` in `src`. */
function objectLiteralsFor(rawSrc, key) {
  const src = maskNonCode(rawSrc);
  const out = [];
  for (const m of src.matchAll(new RegExp(`\\b${key}\\s*:\\s*\\{`, 'g'))) {
    let depth = 0;
    const start = m.index + m[0].length - 1;
    for (let i = start; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) {
        out.push(src.slice(start, i + 1));
        break;
      }
    }
  }
  return out;
}

test('the object-literal extractor is not fooled by braces in comments or strings', async () => {
  // Self-test of the helper, because every assertion below is only as good as
  // it is. Each decoy leaves the flagged style WITHOUT a family and hides one
  // extra `{` — in a comment, then in a string. Counting braces raw, that stray
  // `{` consumes the style's own closing brace, so the slice runs on into the
  // NEXT style and reports APP_FONT_FAMILY as present: a guard that reads green
  // over a tab bar still rendering in the system font, which is the precise
  // failure this file was rewritten to stop.
  const decoys = {
    comment: '  tabBarLabelStyle: { fontSize: 11 /* stray { */ },',
    string: "  tabBarLabelStyle: { fontSize: 11, testID: 'stray {' },",
  };
  for (const [kind, line] of Object.entries(decoys)) {
    const src = ['const a = {', line, '  headerTitleStyle: { fontFamily: APP_FONT_FAMILY },', '};'].join('\n');
    const [labelStyle] = objectLiteralsFor(src, 'tabBarLabelStyle');
    assert.ok(labelStyle, `extractor found no tabBarLabelStyle literal (${kind} decoy)`);
    assert.doesNotMatch(labelStyle, /APP_FONT_FAMILY/, `${kind} decoy swallowed the next style`);
    assert.match(labelStyle, /fontSize: 11/);
    // The stray brace must not have leaked the following key in either.
    assert.doesNotMatch(labelStyle, /headerTitleStyle/);
  }
  // A key named only inside a comment or a string is not a declaration.
  assert.deepEqual(objectLiteralsFor('// tabBarLabelStyle: { x }', 'tabBarLabelStyle'), []);
  assert.deepEqual(objectLiteralsFor("const s = 'tabBarLabelStyle: { x }';", 'tabBarLabelStyle'), []);
});

test('navigator-rendered text styles declare the app font family', async () => {
  const offenders = [];
  for await (const file of walk(path.join(root, 'app'))) {
    const src = await readFile(file, 'utf8');
    for (const key of FRAMEWORK_TEXT_STYLE_OPTIONS) {
      for (const literal of objectLiteralsFor(src, key)) {
        if (!literal.includes('APP_FONT_FAMILY')) {
          offenders.push(`${path.relative(root, file).split(path.sep).join('/')} → ${key}`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `navigator text styles missing APP_FONT_FAMILY (the framework renders these, so the ui/Text wrapper never sees them): ${offenders.join(', ')}`,
  );
});

test('the bottom tab bar renders its labels through the ui/Text wrapper', async () => {
  // The tab labels are the one text surface React Navigation renders FOR us,
  // from the `title` screen options, so the import fence above cannot see them.
  // Styling them via `tabBarLabelStyle` was enough for the typeface but not for
  // the 1.3x cap: `maxFontSizeMultiplier` is a PROP, and bottom-tabs exposes
  // only `tabBarAllowFontScaling`, a hard on/off that test 1 forbids. On Android
  // `allowFontScaling` therefore defaulted to true with no ceiling, so the
  // labels scaled without limit inside a fixed-height bar.
  //
  // The render prop is the only supported hook that reaches the label element.
  // Routing it through the wrapper is what delivers BOTH the cap and the font,
  // so that is what this asserts — not the presence of any particular style.
  const src = await readFile(path.join(root, 'app/(app)/(tabs)/_layout.tsx'), 'utf8');
  assert.match(
    src,
    /import \{ Text \} from '\.\.\/\.\.\/\.\.\/src\/components\/ui\/Text'/,
    'the tabs layout must import the shared Text wrapper',
  );
  const code = maskNonCode(src);
  assert.match(code, /tabBarLabel:\s*\(/, 'tabBarLabel must be a render function');
  // A string label goes back to React Navigation's own <Text>, which the
  // wrapper never sees — the exact bypass this test exists to prevent.
  assert.doesNotMatch(code, /tabBarLabel:\s*['"`]/, 'tabBarLabel must not be a plain string');
  assert.match(code, /<Text\b/, 'the label component must render the shared wrapper');
  // The cap must come FROM the wrapper. Restating it here would be a second
  // source of truth that a future change to the global ceiling would not reach.
  assert.doesNotMatch(code, /maxFontSizeMultiplier/, 'the cap must be inherited from ui/Text, not restated');
});
