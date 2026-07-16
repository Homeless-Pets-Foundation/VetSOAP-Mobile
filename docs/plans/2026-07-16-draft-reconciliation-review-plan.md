# Draft reconciliation review remediation

## Scope

PR #142 moves server-draft reconciliation off the local-draft render path and suppresses the expected Record-First multi-patient warning. This plan records the actionable findings from the external Codex review before the remaining fix is implemented.

## Verified findings

1. **Preserve links across auth changes — fixed.** A probe started for one user could receive a 404 after the global API token changed. Reconciliation now verifies the explicit draft-storage user before acting on a response.
2. **Resume interrupted work on foreground — fixed.** Backgrounded reconciliation did not automatically restart. An AppState listener now resumes it after the interrupted in-flight job unwinds.
3. **Clear only the probed server link — fixed.** A delayed 404 could remove a newer replacement `serverDraftId`. The storage write now compares the expected ID before clearing it.
4. **Abort interrupted probes — fixed.** The probe wrapper previously resolved on background/deadline while its underlying API request continued. Probes now abort their fetch and use passive auth handling, so a late response cannot invoke global auth/device/MFA handlers.

## Remediation

- Add optional external `AbortSignal` support to `ApiClient.request()` and its fetch attempts.
- Add a passive-request mode that never invokes auth refresh, device registration/revocation, session-expiry, or MFA handlers; reconciliation probes use it so an auth switch is safe even before cancellation propagates.
- Stop request processing whenever the external signal is aborted.
- Give each reconciliation probe an `AbortController` and abort it on deadline or background interruption.
- Add regression assertions for signal propagation and run the full test, lint, and typecheck suites.

## Verification

- `npm test` — 376 passed
- `npm run lint` — passed
- `npm run typecheck` — passed
- `git diff --check` — passed
