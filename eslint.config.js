// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*", ".expo/*", ".worktrees/*"],
  },
  {
    // Text-scaling fence. `src/components/ui/Text.tsx` is the only place allowed
    // to touch react-native's Text/TextInput; it applies the 1.3x
    // maxFontSizeMultiplier cap that dense clinical layouts depend on.
    //
    // The previous cap was a monkey-patch of `Text.render` in app/_layout.tsx.
    // RN 0.83 has no `.render` static on either component, so it silently never
    // ran and text scaled to 3.58x unnoticed. A wrapper only holds if nothing
    // routes around it, so this rule catches a bypass in the editor and
    // tests/font-scaling-guard.test.mjs catches it in CI.
    files: ["app/**/*.{ts,tsx}", "src/**/*.{ts,tsx}"],
    ignores: ["src/components/ui/Text.tsx"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{
          name: "react-native",
          importNames: ["Text", "TextInput", "TextProps", "TextInputProps"],
          message:
            "Import Text/TextInput from src/components/ui/Text instead — it applies the 1.3x font-scaling cap. See tests/font-scaling-guard.test.mjs.",
        }],
      }],
    },
  },
]);
