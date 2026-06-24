# Z.ai Provider Fallback Logging and Notification Plan

The detailed implementation plan is saved in the backend repo:

`/home/philgood/Projects/VetSOAP-Connect/docs/zai-provider-fallback-logging-notification-plan-2026-06-24.md`

This mobile repo will consume that backend work through a small owner/admin
banner fed by `GET /api/organization/provider-issues?status=active&days=1`.

Mobile-specific requirements from the plan:

- Show provider issue warnings only to `owner` and `admin` users.
- Prefer Home and Settings surfaces; do not interrupt recording workflows.
- Provide "Dismiss for now" by calling
  `POST /api/organization/provider-issues/acknowledge` with the issue's
  `issueKey`.
- Use existing `src/components/ui/Banner.tsx` styling.
- Fetch provider issues through a non-blocking query; do not gate app rendering.
- Wrap async callbacks with `.catch()` and preserve all Android crash-prevention
  rules from `AGENTS.md`.

Implemented 2026-06-24:

- `src/api/providerIssues.ts` calls the backend provider-issues endpoints through
  the hardened `ApiClient`.
- `src/components/ProviderIssueBanner.tsx` renders a non-blocking owner/admin
  warning, refetches on screen focus and foreground resume, and acknowledges
  from Settings.
- Home and Settings render the banner; recording workflows do not.
- Message should be PHI-free. Example:

```text
Z.ai GLM-5.2 needs attention.
Gemini fallback is completing SOAP notes, but Z.ai reported insufficient funds
(code 1113). Add funds in Z.ai, then reprocess one note to confirm recovery.
```

The backend plan contains the durable logging schema, error classification,
email notification policy, API contract, tests, rollout steps, and runbook.
