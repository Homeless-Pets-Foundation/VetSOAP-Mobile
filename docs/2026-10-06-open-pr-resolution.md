# Open PR resolution — 2026-10-06

Cross-repository plan and verified inventory: [Connect resolution record](https://github.com/Homeless-Pets-Foundation/VetSOAP-Connect/blob/security/shell-quote-20261006/docs/plans/2026-10-06-open-pr-resolution.md).

Mobile main at start: `1fcf269`. Preserve the existing `fix/recording-remedies-draft-sync-20260907` working branch. Apply shell-quote 1.11.0 in a separate security PR; restore the Mac runner; complete #234, #228 and #233 with required current-head checks; consolidate CodeQL updates in #229, then close #231/#232. Keep strict up-to-date and administrator enforcement. Store releases and submissions are outside this task.

The runner API lists only Linux; `macmini-ios` SSH timed out. Mac restoration, Swift CI, Xcode 27 simulator build and device acceptance remain required.

Security validation: Node 20 clean Linux CI passed all 1,303 tests, typecheck, lint, both R2 contracts and Expo SDK dependency checks. Frozen install applies the existing native patches. Installed shell-quote 1.11.0 rejects all four post-comment line terminators. The npm audit reports no critical advisories and no shell-quote advisory; existing unrelated high/moderate advisories remain outside this narrowly scoped security baseline. Swift remains pending Mac restoration.

- Consolidated #229 updates all six CodeQL init/autobuild/analyze uses in both workflows to verified v4.38.2 commit `2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2`. Dependabot groups future `github/codeql-action/*` updates. Manual dispatch, PR-head confirmation, trusted attestation, runner admission and permissions are unchanged. #231/#232 remain open until this complete update merges.

- #229 local review found no merge-relevant issues. Node 20 clean Linux CI passed 1,303 tests, typecheck, lint, SDK and R2 checks. All workflow/config YAML parses; manual-only CI trigger and six matching pinned CodeQL actions verified. Swift and the complete current-head pipeline remain required remotely.

- #229 merged at `b2af0c5` after all nine required current-head checks and manual CI [37502215872](https://github.com/Homeless-Pets-Foundation/VetSOAP-Mobile/actions/runs/37502215872) passed. #231/#232 closed as superseded with branch references retained.
- #228 refreshed against security/CodeQL main. Local review verifies the raise-only pod loop, missing-anchor failure, idempotence, unconditional registration and matching iOS 16 app floor. The approved plan authorizes dropping iOS 15. Node 20 clean Linux CI passed 1,307 tests and all checks. Xcode 27 simulator build and recorder/recovery acceptance remain in progress; no store/version/deployment work.
