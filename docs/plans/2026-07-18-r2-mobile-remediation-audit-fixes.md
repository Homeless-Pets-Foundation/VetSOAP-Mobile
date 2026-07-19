# R2 Mobile Remediation Audit Fixes

Source: VetSOAP-Connect
`docs/plans/2026-07-18-r2-mobile-sentry-remediation.md`.

## Verified findings

- [x] Move the typed `RECORDING_AUDIO_MISSING` stale-render handling from the
      unrelated review mutation to the recording retry mutation, including
      clearing its presentation state after a successful retry.
- [x] Scope the source regression assertion to the retry mutation so the test
      cannot pass when the handler appears elsewhere in the detail screen.
- [x] Replace the static production-wrapper assertion with runtime coverage
      proving missing/malformed R2 configuration fails closed and both exact
      contract styles pass under `__DEV__ = false`.
- [x] Stop orphan cleanup and age eviction before mutation when the shared
      presence snapshot is unknown, canceled, backgrounded, or no longer in
      the initiating user's draft scope.
- [x] Bind orphan cleanup, age eviction, and draft deletion to the initiating
      user for their entire asynchronous lifetime. A user switch in the narrow
      window after the screen-level guard can otherwise make the storage
      methods capture the successor user; `deleteDraft()` also reads and writes
      the mutable current user's index after awaiting user-scoped deletion.
      Add explicit-user storage operations, recheck a scope/version guard
      before destructive work and before presenting/acting on eviction UI, and
      cover the A-to-B switch race with runtime tests.
- [x] When the typed missing-audio race overrides a stale `audioFileUrl`, hide
      the failed-recording Reprocess action immediately as part of the same
      non-retry presentation. Waiting for the invalidated detail query leaves a
      second processing action briefly available against audio already proven
      absent. Add a source regression assertion for the shared presentation
      gate.
- [x] Run the focused retry/reconciliation tests, full Mobile
      test/typecheck/lint/Expo Doctor
      suite, and audit the resulting diff before replacing the preparatory
      Mobile commit.
