# Captivet audit improvements: implementation and verification

The [agreed plan](captivet-audit-improvements-implementation-plan-2026-10-28.md) has implementation evidence for F1–F10. Release acceptance remains open for the unavailable iOS build, physical-device checks and the required CI sequence described below. No production deployment, merge, store submission or production recovery operation was performed.

Work is isolated in `/home/philgood/Projects/VetSOAP-Mobile-audit-20261028` and `/home/philgood/Projects/VetSOAP-Connect-audit-20261028`. The original checkouts, including unrelated Connect work, were preserved.

## Review sequence

| Change | Branch | Review |
|---|---|---|
| Guidance, recovery destinations and consistency | `feat/audit-guidance-recovery` | [Mobile #256](https://github.com/Homeless-Pets-Foundation/VetSOAP-Mobile/pull/256) |
| Completed-note reading | `feat/audit-note-reading` | [Mobile #257](https://github.com/Homeless-Pets-Foundation/VetSOAP-Mobile/pull/257) |
| Template availability and export status | `feat/audit-templates-export` | [Mobile #258](https://github.com/Homeless-Pets-Foundation/VetSOAP-Mobile/pull/258) |
| Read-only recovery preview | `feat/audit-recovery-preview` | [Mobile #259](https://github.com/Homeless-Pets-Foundation/VetSOAP-Mobile/pull/259) |
| Complete history and native date selection | `feat/captivet-audit-improvements` | [Mobile #260](https://github.com/Homeless-Pets-Foundation/VetSOAP-Mobile/pull/260) |
| Additive history API | `feat/captivet-history-api` | [Connect #822](https://github.com/Homeless-Pets-Foundation/VetSOAP-Connect/pull/822) |

Mobile changes are stacked in the agreed order. The API change is independent and must deploy before Mobile history controls release. Earlier Mobile changes can ship independently. The native-acceptance permission-gate scrolling fix was added to #256 and carried forward through the stack without changing the final tested source tree.

## Finding evidence

| Finding | Implementation | Acceptance evidence |
|---|---|---|
| F1: completed notes first | Compact identity, attention, SOAP/transcript and copy, tasks, export, collapsed lazy audio, then Tools. Existing metadata editor and remediation paths remain. | Layout/attention guards pass. Synthetic ordinary Buddy note shows Copy All and readable Subjective without scrolling at the audited Pixel geometry, 1.15 font scale and Bold text. Screenshot: `note-first-stable.png`. |
| F2: misleading metadata guidance | Saved trimmed fields, including PIMS ID, determine whether details exist; populated unresolved reviews use neutral guidance. | Executable populated conflict/zero-applied, blank, PIMS-only and whitespace cases pass; review-resolution guards remain. |
| F3: status label | Search has its own row; status occupies full width; shared Select unchanged. | `not-submitted-full-width.png` shows the complete label at audited geometry and Bold text. Font/layout guards pass. |
| F4: recovery destinations | Existing durable banner on Record, including the microphone gate; Settings links to durable recovery; staff vault separately named and role-gated. | Recovery/permission/role wiring guards pass. `recovery-microphone-gate.png` records recovery access without granting microphone permission. The final permission-gate follow-up makes recovery and Continue scroll together at large text sizes; `microphone-gate-scroll-bottom.png` shows the full Continue action at 320 dp and font scale 2.0. |
| F5: recovery preview | Current offer/user/path validation; bounded 1 MiB complete-frame prefix; at most 60 seconds; temporary AAC; one player; bounded preparation/loading; cancellation and cleanup. No manifest bridge hydration or source mutation. | Parser/preparation/playback/preservation tests pass, including failures, torn tails, late results, account/lock/background and active/paused recorder ownership. Native 70-second synthetic AAC plays a capped preview with Play/Pause/Stop. Source audio and manifest SHA-256 values match before/after listening and stopping. Screenshots: `recovery-60s-cap.png`, `recovery-native-playing.png`, `recovery-native-paused.png`, `recovery-after-stop.png`. |
| F6: complete history | Server-side activity date/range/order before pagination; both sources paginate; same local-draft rules; deterministic date groups/ties; independent filters; Just submitted; cancellation; default-only user-scoped persistence. | Executable tests cover more than two pages per source, both directions, fallback/ties, combined filters, deduplication, cancellation, old-server rejection and source failures. Calendar tests cover leap/year/month boundaries, DST start/end, skipped midnights, exact bounds and preset rollover. Native Android picker and custom Apply captured in `native-date-picker.png` and `custom-range-applied.png`. `history-320dp-dark-large-text-fixed.png` shows the unsplit heading and wrapping controls at 320 dp, large text and dark mode. |
| F7: templates | Initial/loading/empty/error/retry/cached-error/unavailable-selection states; saved choice retained; retry props wired through memoized callers. | Executable availability, retry, selection and caller guards pass. Native empty/no-selection guidance is captured in `native-template-empty.png`; the remaining native failure/cached-state matrix remains a device acceptance item. |
| F8: export status | Explicit Marked exported at note and row; memo comparison; returned SOAP patches current detail/recent/list caches with account/unmount guards. | Success/failure/cache/memo tests pass; copy/share cancellation leaves export state unchanged. Native copy/share cancellation, explicit marking and the updated recording row pass (`native-export-after-share-cancel.png`, `native-export-marked.png`, `native-export-recording-row.png`); native failure/iOS cases remain open. |
| F9: SOAP expansion | Independent sections; Subjective initially open; stable note keys; drafts survive collapse and transcript switching; cached note remains during failed background refresh. | Executable multi-section/collapse/reopen/refetch and existing dirty/save-in-flight/failure exit guards pass. `soap-multiple-sections-final.png` and `tablet-landscape-note.png` show Subjective and Objective open together, including after rotation. |
| F10: consistency | Platform-specific download destination; Android Patients clear-search; readable Clinic Quality role labels in visible/accessibility text. | Platform, font scaling, role and caller guards pass. Native search clearing restores the patient list (`native-patients-search-cleared.png`); `native-quality-role-labels.png` and its hierarchy confirm “Support staff” in visible and accessibility text. Physical screen-reader verification remains open. |

## Automated and native checks

| Check | Result |
|---|---|
| Mobile `npm run typecheck` | PASS |
| Mobile `npm run lint` | PASS |
| Mobile `npm test` | PASS: 1,571 tests, no skips or failures |
| `npx expo install --check` | PASS; only new dependency is SDK-compatible `@react-native-community/datetimepicker` 8.6.0 |
| Android local-test release compilation | PASS: `:app:assembleRelease`, including the native picker |
| Mobile #256 required CI at `369bf66a5785f1958ddaf9de7e600151c8877a7c` | PASS: all required contexts, including CodeQL, Review, Swift, Node tests, lint/typecheck, SDK and R2 contracts |
| Connect `TURBO_ENV_MODE=loose VITEST_MAX_WORKERS=2 pnpm verify` | PASS: all 33 tasks and subsequent guards |
| Connect current-head CI at `eb4397b5209b7a66264c1c54ce1bb326fd57aa25` | PASS: all jobs, including six browser shards, build, security, CodeQL and API smoke |
| Connect isolated PostgreSQL/RLS | PASS: 40 focused route/history tests including 9 real PostgreSQL/RLS cases; full foundation RLS suite 24 passed |

See [Connect implementation notes](https://github.com/Homeless-Pets-Foundation/VetSOAP-Connect/blob/feat/captivet-history-api/docs/captivet-audit-improvements-implementation-notes-2026-10-28.md) for query-plan, timezone and API evidence. [Connect current-head CI](https://github.com/Homeless-Pets-Foundation/VetSOAP-Connect/actions/runs/40741320238) passes after correcting a CodeQL finding in the synthetic test artifact writer. The fix uses a private temporary directory and exclusive mode-0600 file creation; the subsequent scan reports the finding fixed.

[Mobile #256 current-head CI](https://github.com/Homeless-Pets-Foundation/VetSOAP-Mobile/actions/runs/40743572467) and all required attested contexts are green. An earlier dispatch briefly saw GitHub’s stale pre-push PR head; it was rerun after head synchronization, without changing the gate.

The Mobile workflow intentionally accepts only a default-branch-base PR. Stacked PRs #257 onward must be retargeted after their parent merges and then receive a successful manual CI run and required-check attestation at each current head. Local final-tree checks do not replace those merge gates. No workflow or protection was bypassed.

## Synthetic device scope and remaining acceptance

Screenshots, UI hierarchies, hashes, logs and the synthetic query plan are outside Git at `/home/philgood/captivet-audit-evidence/2026-10-28/implementation/`. The isolated fixture source is `/tmp/captivet-audit-device-app`; it blocks network requests, uses synthetic users/notes/audio and a separate local-test package. The product APK and bundle contain no fixture entry point. No real recovery offers or production device state were used.

Android checks use a newly created `CaptivetAudit20261028` API-36 emulator (`emulator-5580`), rather than the existing devices. Audited geometry is 1344×2992 at density 480 with font scale 1.15 and font weight adjustment 300. Narrow checks use 960×2144 at density 480 (320 dp), font scale 2.0 and dark mode. Native checking exposed and fixed recovery action/title clipping, a split history heading and permission-gate overflow after adding the banner. Accepted narrow recovery captures end in `-fixed`; earlier captures are diagnostic evidence, not acceptance results. Tablet landscape layout/rotation is also checked on the emulator (`tablet-landscape-note.png`, `tablet-landscape-history.png`). Android Back cancels an unapplied Today selection (`dates-cancelled-android-back.png`). These checks do not replace physical tablet or gesture acceptance. The dedicated emulator was stopped after evidence capture; its AVD and synthetic fixture APK remain available for review.

The native preview uses a synthetic 70-second mono 16 kHz AAC source. Its complete-frame preview is at most 60 seconds (937 AAC frames at this rate, 59.968 seconds). Automated preservation assertions also cover offers, drafts, holds, tombstones and upload state. Native hashes independently cover source bytes and manifest contents.

The full iOS rebuild remains blocked by Mac connectivity. The live Windows Tailscale backend is running, but both macOS peers report offline: `phils-mac-mini-1.tail56970f.ts.net` (100.77.226.18, last seen October 18) and `phils-mac-mini.tail56970f.ts.net` (100.105.159.99, last seen September 29). SSH through the live Tailscale `nc` connection times out before authentication. The successful Swift CI job is not a full iOS application build.

Before release, complete the local iOS prebuild/pods/application build and iOS picker/back-gesture acceptance; rerun the matrix on the physical audited Pixel, TalkBack and physical tablet rotation; complete native template/export/failure matrices and all current-head merge gates. The emulator evidence is supplementary and does not establish physical-device or iOS acceptance.

Deploy and verify the additive Connect API first, then release fresh Android and iOS binaries for the picker. Older servers deliberately produce an unavailable/error state rather than silently ignoring history filters. Existing monitoring remains unchanged; no clinical content, search text or local paths were added to telemetry.
