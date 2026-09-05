/**
 * Guard: the AudioWaveform container's className must stay CONSTANT.
 *
 * Bisected on an Android emulator 2026-09-05. The container carried
 * `${live ? 'shadow-glow' : ''}`, so its className changed at the exact moment
 * capture started. Under `jsxImportSource: 'nativewind'` every element renders
 * through cssInterop, and on this node a CHANGING className ended up handing
 * the plain host View a Reanimated animated style. Reanimated's dev-only
 * `_requiresAnimatedComponent` getter throws the moment it is read
 * ("Perhaps you are trying to pass an animated style to a non-animated
 * component"), which killed the Record screen on the first frame of every
 * recording and took the running capture down with it.
 *
 * Three measurements pin it, and this guard exists because only one of them is
 * obvious from the source:
 *   - conditional `shadow-glow` on this node  -> throws
 *   - the same className held constant        -> does not throw, WITH or
 *     WITHOUT `shadow-glow`
 *   - the identical glow toggled through the inline `style` prop -> does not
 *     throw
 * So the hazard is the className changing, not the glow, and not `live`.
 *
 * Release builds never threw — that getter only exists under __DEV__ — which is
 * why no vet ever hit this and Sentry recorded nothing. That is precisely what
 * makes it worth fencing: the failure is invisible in production and fatal in
 * every dev/emulator session, which is how the perf work that introduced the
 * surrounding code reached main without ever being run on a device.
 *
 * Deliberately narrow: sibling conditional `shadow-glow` sites (StatusBadge,
 * PatientSlotCard, RecorderLiveReadout) did NOT reproduce it, so this asserts
 * the node that was measured rather than a blanket rule about conditional
 * classNames.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/components/AudioWaveform.tsx', import.meta.url), 'utf8');

/**
 * True only for a className whose value is a STRING LITERAL — `className="..."`
 * or `className={'...'}`.
 *
 * Rejecting just `${...}` and `live` was not enough (Codex, PR #207): a plain
 * ternary such as `className={isActive ? 'a shadow-glow' : 'a'}` contains
 * neither, yet makes this node's className dynamic again and reinstates the
 * crash. The invariant is "constant", so the guard checks for a literal rather
 * than blacklisting the shapes we happened to think of.
 */
export function isLiteralClassName(value) {
  return /^"[^"]*"$/.test(value) || /^\{\s*(['"`])(?:(?!\1)[^\\$])*\1\s*\}$/.test(value);
}

/** The container `<View>` rendered by AudioWaveform, up to its first child. */
function containerElement() {
  const fnStart = SRC.indexOf('export const AudioWaveform = React.memo(');
  assert.ok(fnStart > 0, 'AudioWaveform component not found');
  const open = SRC.indexOf('<View', fnStart);
  assert.ok(open > fnStart, 'AudioWaveform renders no container <View>');
  const close = SRC.indexOf('>', SRC.indexOf('accessibilityRole', open));
  assert.ok(close > open, 'container <View> props not bounded');
  return SRC.slice(open, close);
}

test('the literal check rejects every dynamic className shape, not just the one that broke', () => {
  // Asserted directly so this guard cannot go vacuous the way the first draft
  // did: these are the shapes a future edit would plausibly reach for.
  assert.ok(isLiteralClassName('"flex-row items-center rounded-card"'));
  assert.ok(isLiteralClassName("{'flex-row items-center rounded-card'}"));

  assert.ok(!isLiteralClassName("{`flex-row ${live ? 'shadow-glow' : ''}`}"), 'template interpolation');
  assert.ok(!isLiteralClassName("{isActive ? 'flex-row shadow-glow' : 'flex-row'}"), 'ternary');
  assert.ok(!isLiteralClassName('{cn("flex-row", live && "shadow-glow")}'), 'helper call');
  assert.ok(!isLiteralClassName('{containerClass}'), 'identifier');
  assert.ok(!isLiteralClassName("{'flex-row ' + extra}"), 'concatenation');
});

test('the AudioWaveform container className is a constant literal', () => {
  const el = containerElement();
  const className = /className=(\{[^}]*\}|"[^"]*")/.exec(el);
  assert.ok(className, 'container <View> has no className');
  const value = className[1];

  assert.ok(
    isLiteralClassName(value),
    `container className must be a string literal, got ${value} — a className that CHANGES when capture starts throws ReanimatedError in dev and kills the recording`
  );
});

test('the glow is applied through the inline style, so it still appears while recording', () => {
  const el = containerElement();
  // Fixing the crash by simply deleting the glow would pass the test above and
  // silently drop the visual that marks a live recording.
  assert.match(el, /boxShadow/, 'the recording glow must still be applied inline');
  assert.match(
    el,
    /live \?/,
    'the inline glow must still be conditional on `live`, or it shows when idle too'
  );
});

test('`live` is still computed — the glow is conditional, not always-on', () => {
  assert.match(SRC, /const live = isActive && !isPaused;/);
});
