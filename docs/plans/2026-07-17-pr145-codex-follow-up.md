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

## Exact-head follow-up (`26685055e4`)

The next Codex review reported three additional merge-blocking findings.

1. **P2 — metadata remains editable during restart persistence:** valid. The
   controlled-restart guard protects audio mutation and submission, but form
   updates can still race the snapshot passed to the upload path.
2. **P2 — concurrent draft sync work is dropped:** valid. A second sync returns
   while the first request is active, so newer metadata is not guaranteed to
   reach the server and a stash flush may not wait for the server draft anchor.
3. **P1 — partial segment saves replace complete restart metadata:** valid.
   `saveDraft()` can commit a partial segment list before the controlled
   restart detects the cardinality mismatch.

### Implementation

- Freeze every metadata-update entry point for a slot while its controlled
  restart guard is active.
- Serialize per-slot server draft syncs with a promise tail so each newer
  request runs after the current one, and make flush await active work even
  when no debounce timer remains.
- Add a complete-audio save mode for controlled restarts that writes to
  versioned files, refuses partial copies before the metadata commit, and
  leaves the last complete draft snapshot intact on failure.
- Add regression coverage for the metadata guard, queued sync/flush behavior,
  and all-or-nothing restart persistence.

## Exact-head follow-up (`26f2b96ed9`)

The next Codex review reported four additional merge-blocking findings.

1. **P1 — restart continuation can cross authentication scope:** valid. A
   local persistence promise can outlive the Record screen and start upload
   under a subsequently signed-in user's API session.
2. **P2 — complete restart snapshots accumulate:** valid. Versioned copies
   protect the prior draft during commit, but the newly superseded files are
   not removed after metadata makes the new version authoritative.
3. **P1 — durable audio mutation falls back to the superseded key:** valid.
   Clearing the restart pair rotates `uploadIntentId`, but the durable
   idempotency resolver ignores that field and reuses the original durable key;
   the native manifest also retains its old restart identity.
4. **P2 — inspected recovery survives slot edits:** valid. Metadata edits and
   audio mutations without an existing proof/restart pair can retain a
   `restart_available` classification for an obsolete snapshot.

### Implementation

- Capture a user-scope generation for controlled restart and abort every late
  continuation, including the final upload start, unless that exact scope is
  still mounted and current.
- After complete metadata commits, delete only superseded audio files proven
  confined to that slot's draft directory; retain the new authoritative set.
- Add an ordinary fresh audio-change upload identity and rotate it atomically
  across SecureStore plus the native durable manifest before durable Continue
  can append bytes.
- Preserve metadata-only server drafts when that fresh identity has not begun
  an audio upload; rotate only when upload/recovery evidence makes reuse unsafe.
- Clear ephemeral recovery classification on every metadata edit, and rotate
  or clear it on every audio mutation so the next submit re-inspects current
  state.
- Add focused source and behavior coverage for scope invalidation, confined
  cleanup, durable identity rotation, and edit invalidation.
