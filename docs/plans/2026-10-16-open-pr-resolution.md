# Open PR resolution — October 16, 2026

## Scope

Review and resolve every open PR, including drafts, present in the initial GitHub inventory.
Preserve original heads and existing worktrees. Consolidate compatible proposals into one
replacement PR per repository; close originals only after a checked replacement merges.

Base: `5639e31538c6618b2ec02de3fbe729b4a84a2b37`. No draft PRs were open.

| PR | Initial head | Proposal |
| --- | --- | --- |
| [#239](https://github.com/Homeless-Pets-Foundation/VetSOAP-Mobile/pull/239) | `ee056c609dd8cf5dfef536921247b37343e2c9f2` | chore(deps): bump the production-dependencies group with 2 updates |
| [#240](https://github.com/Homeless-Pets-Foundation/VetSOAP-Mobile/pull/240) | `17bed8333f21263cafcf19eca79d13bb5900fcd9` | chore(deps): bump the codeql-actions group with 3 updates |

## Review and implementation plan

1. Inspect both PRs and their resolved lock deltas; verify Supabase/PostHog release changes.
2. Apply the runtime changes without moving the Expo/RN/React/native-patch baseline.
3. Keep all six CodeQL action references synchronized at the verified release SHA.
4. Run frozen Linux CI, Expo SDK compatibility, R2 contracts, installed-auth SDK and account-isolation
   regressions. Let exact-head manual CI run Swift verification on the existing Mac runner.
5. Review final diff, open replacement PR, dispatch manual CI, and merge only after current-head
   required contexts pass. Close originals with replacement evidence.

## Constraints

Do not modify branch protection, bypass status gates, deploy manually, publish a store build,
change persistent production data, or hand-edit public changelog outputs. Record failed/skipped
checks accurately. The normal main-merge deployment workflow remains enabled.

## Execution evidence

- Reviewed #239: Supabase 2.117.3 fixes functions content types, PostgREST timeout retry
  classification and multipart ordering; it does not change the auth contract. PostHog 4.80.0
  retains the explicit no-lifecycle/no-navigation/no-replay configuration and allowlisted events.
- Reviewed #240: every init/autobuild/analyze reference in both workflows points to
  `24c54180a607b1449ed407dd24f251e4e9147c8d`, the dereferenced upstream v4.38.3 tag.
  No trigger, permission, runner or attestation changes.
- Fresh `npm run ci:linux` on Node 22.22.2 passes: frozen install and both native patches,
  both R2 contracts, Expo SDK compatibility, TypeScript, lint and all 1,375 tests; no skips.
  The suite includes installed Supabase/TanStack regressions and account-isolation tests.
- `git diff --check` passes. No native source, Expo/RN/React version, marketing version,
  telemetry configuration or R2 destination changed.
- Required GitHub CI and Mac Swift validation remain pending at the replacement head.
