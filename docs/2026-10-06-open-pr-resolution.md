# Open PR resolution — 2026-10-06

Cross-repository plan and verified inventory: [Connect resolution record](https://github.com/Homeless-Pets-Foundation/VetSOAP-Connect/blob/security/shell-quote-20261006/docs/plans/2026-10-06-open-pr-resolution.md).

Mobile main at start: `1fcf269`. Preserve the existing `fix/recording-remedies-draft-sync-20260907` working branch. Apply shell-quote 1.11.0 in a separate security PR; restore the Mac runner; complete #234, #228 and #233 with required current-head checks; consolidate CodeQL updates in #229, then close #231/#232. Keep strict up-to-date and administrator enforcement. Store releases and submissions are outside this task.

The runner API lists only Linux; `macmini-ios` SSH timed out. Mac restoration, Swift CI, Xcode 27 simulator build and device acceptance remain required.

Security validation: Node 20 clean Linux CI passed all 1,303 tests, typecheck, lint, both R2 contracts and Expo SDK dependency checks. Frozen install applies the existing native patches. Installed shell-quote 1.11.0 rejects all four post-comment line terminators. The npm audit reports no critical advisories and no shell-quote advisory; existing unrelated high/moderate advisories remain outside this narrowly scoped security baseline. Swift remains pending Mac restoration.

Merged the Mobile security baseline through [#235](https://github.com/Homeless-Pets-Foundation/VetSOAP-Mobile/pull/235) at `3cb4d6a`, after all nine required current-head checks passed. Restored `vetsoap-local-ci-macos` in the existing `vetsoapci` account with the exact required labels. Apple Git submodule commands took approximately 100 seconds; the installed Homebrew Git completed the same read in 0.3 seconds. The supervised runner uses Homebrew Git and completed the security Swift check successfully. A LaunchAgent is installed; loading it from this SSH-only user session failed, so reboot persistence remains unverified. The old queued #234 run was cancelled; its branch was then updated against the security main.

Refreshed #234: all 11 review threads remain resolved. Reviewed the auth restore/refresh generations, account-scoped cache fallback, request-id provenance, serialized durable flag persistence and Submit ownership checks. Node 20 clean Linux CI passed all 1,344 tests plus typecheck, lint, R2 contracts and Expo SDK checks. Device acceptance still needs an approved synthetic account/evidence; requested that information while completing CI and build preparation.
