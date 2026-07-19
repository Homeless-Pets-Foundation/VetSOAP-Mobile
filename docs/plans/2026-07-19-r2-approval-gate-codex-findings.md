# R2 Approval Gate Codex Findings

## Audit source

Codex reviewed VetSOAP-Mobile PR #151 at
`395625e8f940f5a099ccc67d921569f8f6cd7f6d`.

## Verified findings

1. **P1 — protected-file renames can bypass approval.** GitHub's pull-request
   file response reports a renamed file's new path in `filename` and its old
   path in `previous_filename`. The gate checks only `filename`, so moving a
   protected file to an unprotected path can incorrectly pass.
2. **P2 — the 3,000-file API cap can truncate protected paths.** GitHub caps
   the pull-request files response at 3,000 entries. Treating that response as
   complete can incorrectly pass an oversized PR when a protected file is
   beyond the cap.

Both findings are real and affect the identical gate implementation in Mobile
and Connect.

## Fix plan

1. Match both `filename` and `previous_filename`, de-duplicating paths before
   protected-path evaluation.
2. Treat a response containing 3,000 files as potentially truncated and
   require the current-head R2 approval even when no returned path matches.
3. Add regression tests for rename removal, rename into a protected path, and
   the exact 3,000-file fail-closed boundary in both repositories.
4. Run the direct gate suites, repository lint/type checks, and diff checks,
   then request fresh Codex reviews on the new head SHAs.
