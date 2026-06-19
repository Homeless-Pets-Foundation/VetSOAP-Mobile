# Server bug: `create_draft` returns HTTP 500 (~51 in 30d) — 2026-06-18

**Owner:** VetSOAP-Connect (server / `api.captivet.com`) — out of scope for the mobile repo.
**Filed from:** mobile Sentry triage (this session). GH issue: `Homeless-Pets-Foundation/VetSOAP-Connect`.

## Summary

When the mobile app creates a draft recording row (the `create_draft` upload phase — `POST` to the recordings draft-create endpoint), the server returns **HTTP 500** ("A server error occurred. Please try again later."). Over the last 30 days this happened **51 times** — by far the dominant `create_draft` failure mode.

This is a **server-side fault**, not a mobile bug. Mobile PR #92 reclassified HTTP 5xx as a *recoverable* failure so it no longer pages as a hard client error (`captureException`); it is now a telemetry warning. But the user still sees a failed draft-create, and the underlying server fault persists.

## Evidence (Sentry — org `vetsoap-mobile`, project `react-native`)

`create_draft` phase, last 30 days, grouped by `error_code`:

| error_code | count | title |
|---|---|---|
| **HTTP_500** | **51** | `ApiError: A server error occurred. Please try again later.` |
| ROLE_FORBIDDEN | 10 | role cannot create/upload/delete |
| CREDENTIALS_REQUIRED | 7 | credentials required |
| CREATE_DRAFT (network) | 1 | `TypeError: Network request failed` |
| CREATE_DRAFT (abort) | 1 | `AbortError: Aborted` |
| HTTP_404 | 1 | not found |

Discover query (mobile side):
```
phase:create_draft   (dataset: errors, fields: title,count(),phase,error_code)
```

Client telemetry (server `client_telemetry` table) one-query view:
```sql
SELECT phase, error_code, network_state, app_version, message, created_at
FROM client_telemetry
WHERE phase = 'create_draft' AND error_code = 'HTTP_500'
ORDER BY created_at DESC;
```

## What to investigate (server)

1. The draft-create handler (the `POST` recordings endpoint that creates a `Recording` row with `status='draft'`). A 500 implies an unhandled exception, not a validation/permission rejection (those return 403/401/404, which are present and correctly handled).
2. Likely candidates: a DB constraint/unique violation on the draft insert, a null/over-length field from the mobile payload, an idempotency-key collision on retry, or a downstream (R2 presign / DB) dependency throwing.
3. Cross-reference the timestamps above with server logs (Railway) to capture the stack trace for one of the 51 occurrences.

## Mobile-side status (already shipped, PR #92)

- HTTP 5xx on submit → `isRecoverableSubmitFailure` → telemetry **warning**, no `captureException`.
- `reportClientError` still fires for every failure, so the server team keeps full `client_telemetry` visibility (phase, code, app_version, network_state) even though mobile stopped paging.
