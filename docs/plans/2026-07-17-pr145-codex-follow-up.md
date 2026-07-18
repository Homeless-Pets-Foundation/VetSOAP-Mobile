# PR 145 Codex Follow-up

## Verified findings

The Codex review of commit `6a79770f98` reported four merge-blocking findings.

1. **P2 — timed-out restart transaction loses its guard:** valid. The watchdog
   returns from `Promise.race`, then the shared `finally` removes the restart
   guard even though the uncancelled SecureStore/native transaction can still
   mutate durable identity state.
2. **P2 — Submit All retries conflicted slots directly:** valid. The batch path
   does not run the confirmed controlled-restart flow or stop with guidance, so
   it resubmits the same conflicted intent.
3. **P1 — late persistence can overwrite a restart:** valid. Prepared-recording
   and R2-confirmation callbacks are allowed to continue after their tactical
   timeout, while the conflict path can expose a controlled restart before
   those writes settle.
4. **P2 — restart identity fields are accepted independently:** valid. A
   surviving replacement override without its superseded key can enter ordinary
   preparation instead of the reconciliation endpoint.

## Implementation

- Separate watchdog/UI completion from transaction coordination so a timed-out
  local restart cannot overlap another submit, draft sync, or audio mutation
  until the underlying operation settles.
- Make Submit All stop before network work when any selected slot requires a
  confirmed controlled restart, and direct the user to that patient.
- Track timed-out prepared/hint persistence work and fail closed without
  offering restart until every late callback has settled.
- Validate replacement and superseded upload keys as one restart identity at
  persisted-state boundaries and immediately before upload; reject partial
  identities instead of falling back to ordinary preparation.
- Add focused regression tests for each concurrency and identity rule.

## Verification

- Run the stale-recording upload behavior and source-contract tests.
- Run durable draft round-trip and multi-patient submission tests.
- Run the full mobile test suite, typecheck, and lint.
- Push the fix, resolve only addressed threads, and request another exact-head
  Codex audit.
