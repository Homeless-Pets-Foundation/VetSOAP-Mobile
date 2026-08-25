import React from 'react';
import {
  Text as RNText,
  TextInput as RNTextInput,
  type TextProps as RNTextProps,
  type TextInputProps as RNTextInputProps,
} from 'react-native';
import { resolveMaxFontSizeMultiplier } from '../../lib/fontScaling';

/**
 * The app's `Text` and `TextInput`. Every text call site imports from here, not
 * from `react-native`, so the 1.3x OS-text-scaling cap is applied exactly once,
 * in one place, and cannot be forgotten.
 *
 * WHY a wrapper instead of a global patch: `app/_layout.tsx` used to monkey-patch
 * `Text.render` / `TextInput.render`. RN 0.83 exports both as plain function
 * components with no `.render` static, so the patch never ran — silently, for
 * every release, on both platforms. A wrapper cannot fail that way: bypassing it
 * is an import, and `tests/font-scaling-guard.test.mjs` fails on any import of
 * `Text`/`TextInput` from `react-native` outside this file (with an ESLint
 * `no-restricted-imports` rule catching it earlier, in the editor).
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

export type TextProps = RNTextProps & { className?: string };
export type TextInputProps = RNTextInputProps & { className?: string };

export function Text({ maxFontSizeMultiplier, ...props }: TextProps) {
  return (
    <RNText
      {...props}
      maxFontSizeMultiplier={resolveMaxFontSizeMultiplier(maxFontSizeMultiplier)}
    />
  );
}

export const TextInput = React.forwardRef<RNTextInput, TextInputProps>(
  function TextInput({ maxFontSizeMultiplier, ...props }, ref) {
    return (
      <RNTextInput
        {...props}
        ref={ref}
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
