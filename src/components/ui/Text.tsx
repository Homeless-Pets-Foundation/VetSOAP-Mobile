import React from 'react';
import {
  Text as RNText,
  TextInput as RNTextInput,
  type TextProps as RNTextProps,
  type TextInputProps as RNTextInputProps,
} from 'react-native';
import { resolveMaxFontSizeMultiplier, type TextScaling } from '../../lib/fontScaling';
import { APP_FONT_FAMILY } from '../../lib/typography';

/**
 * The app's `Text` and `TextInput`. Every text call site imports from here, not
 * from `react-native`, so the 1.3x OS-text-scaling cap is applied exactly once,
 * in one place, and cannot be forgotten. Long-form reading paragraphs opt into
 * a 2.0x ceiling with `scaling="reading"`; nothing else can raise it.
 *
 * WHY a wrapper instead of a global patch: `app/_layout.tsx` used to monkey-patch
 * `Text.render` / `TextInput.render`. RN 0.83 exports both as plain function
 * components with no `.render` static, so the patch never ran — silently, for
 * every release, on both platforms. A wrapper cannot fail that way: bypassing it
 * is an import, and `tests/font-scaling-guard.test.mjs` fails on any import of
 * `Text`/`TextInput` from `react-native` outside this file (with an ESLint
 * `no-restricted-imports` rule catching it earlier, in the editor).
 *
 * The app typeface is applied here too, base-first (`[{ fontFamily }, style]`), so
 * an explicit per-element fontFamily and NativeWind className styles both still
 * win. RN <Text> does not inherit fontFamily from a parent View, which is why it
 * has to be set on every element rather than once at the root.
 *
 * NativeWind: `className` is forwarded to the underlying RN component, whose JSX
 * element in THIS file is what NativeWind's transform sees. Interop therefore
 * applies to the real `RNText`/`RNTextInput` as before, and these wrappers need
 * no `cssInterop` registration of their own.
 *
 * `TextInput` forwards a ref (login.tsx focuses the password field, and
 * `TextInputField` forwards one through), and re-exports `TextInput` as a TYPE so
 * `useRef<TextInput>` still resolves. `Text` takes no ref because no call site
 * passes one — add `forwardRef` if that changes, rather than reaching past the
 * wrapper to `react-native` for it.
 */

export type TextProps = RNTextProps & {
  className?: string;
  /**
   * `'reading'` raises the ceiling to 2.0x for long-form reading paragraphs
   * (see `READING_MAX_FONT_SIZE_MULTIPLIER`). Fenced to an allowlist of files by
   * tests/font-scaling-guard.test.mjs — never use it on labels, buttons, badges
   * or headers. Nested <Text> spans must pass it too: RN applies
   * maxFontSizeMultiplier per text fragment, so an un-flagged span is capped at
   * 1.3x inside a 2.0x paragraph.
   */
  scaling?: TextScaling;
};
export type TextInputProps = RNTextInputProps & { className?: string };

export function Text({ maxFontSizeMultiplier, scaling, style, ...props }: TextProps) {
  return (
    <RNText
      {...props}
      style={[{ fontFamily: APP_FONT_FAMILY }, style]}
      maxFontSizeMultiplier={resolveMaxFontSizeMultiplier(maxFontSizeMultiplier, scaling)}
    />
  );
}

export const TextInput = React.forwardRef<RNTextInput, TextInputProps>(
  function TextInput({ maxFontSizeMultiplier, style, ...props }, ref) {
    return (
      <RNTextInput
        {...props}
        ref={ref}
        style={[{ fontFamily: APP_FONT_FAMILY }, style]}
        maxFontSizeMultiplier={resolveMaxFontSizeMultiplier(maxFontSizeMultiplier)}
      />
    );
  },
);

/**
 * Type-namespace alias so `useRef<TextInput>` keeps working behind the fence.
 * TypeScript keeps values and types in separate namespaces, so this genuinely is
 * not a redeclaration; the base ESLint rule cannot see the distinction.
 */
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type TextInput = RNTextInput;
