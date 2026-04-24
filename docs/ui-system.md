# Captivet Mobile UI System

The app-owned UI system lives in `src/components/ui` and is built on React Native primitives, NativeWind classes, and `lucide-react-native`. It should stay dependency-light: use ShadCN/React Native Reusables as reference material, but copy/adapt patterns into this folder instead of adding a broad UI framework.

## Primitives

- `Button` and `IconButton` handle press feedback, haptics, accessibility state, and async callback rejection safety.
- `FormField`, `TextInputField`, `Select`, `SegmentedControl`, and `Toggle` provide consistent form labels, required markers, help text, errors, and 44dp minimum touch targets.
- `Sheet` is the shared bottom-sheet modal for option lists and future action panels.
- `ListItem`, `Card`, `Badge`, `Banner`, `EmptyState`, and `Skeleton` cover common list, status, alert, and loading patterns.

## Safety Rules

- Do not pass async callbacks directly to React Native void callbacks. UI primitives that accept async callbacks must invoke them through the shared safe wrapper.
- Fire-and-forget haptics must always include `.catch(() => {})`.
- Any UI callback logging must be gated behind `__DEV__`.
- Use `IconButton`, `Button`, `Toggle`, `Select`, or `SegmentedControl` before adding raw `Pressable`/`Switch` controls in screens.

## Adoption Guidance

- Use `ListItem` for tappable cards/rows with a title, subtitle, metadata, badge, or trailing action.
- Use `EmptyState` for loading failure or zero-result states instead of hand-rolled icon/text/button stacks.
- Use `SegmentedControl` for small inline option sets and `Select` for filters or longer option lists.
- Use `Sheet` for app-styled bottom modal content; keep native `Alert.alert` for simple OS-level confirmations.
