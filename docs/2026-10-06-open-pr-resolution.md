# Open PR resolution — 2026-10-06

Cross-repository plan and verified inventory: [Connect resolution record](https://github.com/Homeless-Pets-Foundation/VetSOAP-Connect/blob/security/shell-quote-20261006/docs/plans/2026-10-06-open-pr-resolution.md).

Mobile main at start: `1fcf269`. Preserve the existing `fix/recording-remedies-draft-sync-20260907` working branch. Apply shell-quote 1.11.0 in a separate security PR; restore the Mac runner; complete #234, #228 and #233 with required current-head checks; consolidate CodeQL updates in #229, then close #231/#232. Keep strict up-to-date and administrator enforcement. Store releases and submissions are outside this task.

The runner API lists only Linux; `macmini-ios` SSH timed out. Mac restoration, Swift CI, Xcode 27 simulator build and device acceptance remain required.

Security validation: Node 20 clean Linux CI passed all 1,303 tests, typecheck, lint, both R2 contracts and Expo SDK dependency checks. Frozen install applies the existing native patches. Installed shell-quote 1.11.0 rejects all four post-comment line terminators. The npm audit reports no critical advisories and no shell-quote advisory; existing unrelated high/moderate advisories remain outside this narrowly scoped security baseline. Swift remains pending Mac restoration.
