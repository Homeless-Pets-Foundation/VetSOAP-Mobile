# iOS Rejection 3.1.3(c) — Reply Draft + Action Items (2026-04-26)

## Live-Site Audit Results

The original plan assumed captivet.com still had consumer-facing copy. **Live audit (2026-04-26) shows the site is already fully B2B-positioned.** No Bricks edits required.

### Verified live state

| Surface | Status | Evidence |
|---|---|---|
| `captivet.com/` | ✅ B2B | All CTAs → `/book-a-demo/`. Hero badge: "Clinic-only subscriptions ✓ Admin-provisioned staff ✓ BAA available". No free trial / individual signup. |
| `captivet.com/pricing/` | ✅ B2B | "Transparent per-seat pricing for licensed veterinary clinics". FAQ: *"Your clinic administrator provisions each staff member… no self-serve signup is required."* |
| `captivet.com/students/` | ✅ Institutional | "AVMA-accredited programs only", "no self-serve signup path for individuals", "deployed only through school administrators — never self-serve". |
| `app.captivet.com/login` | ✅ Login-only | Google SSO + email login. **Zero sign-up affordance.** Only secondary path: "Need access for your clinic? Request a demo" → `/book-a-demo/`. |
| `app.captivet.com/register` | ✅ Redirects | Client-side redirect to `/login`. Same for `/signup`, `/sign-up`. |
| `api.captivet.com/auth/register` | ✅ Gated | Returns HTTP 401 `Missing authorization header`. Defense-in-depth — even attempting to register requires existing auth + invitation. |
| iOS app sign-in | ✅ Login-only | No sign-up button. "Request a demo" link only (commit `c424d81`). |

### Evidence screenshots (saved)

Files in `/home/philgood/projects/VetSOAP-Mobile/.playwright-mcp/`:

- `apple-review-01-homepage-desktop.png` — homepage (1440px)
- `apple-review-02-pricing-desktop.png` — pricing page (1440px)
- `apple-review-03-app-login-no-signup.png` — `app.captivet.com/login` showing no sign-up
- `apple-review-04-students-institutional.png` — students page

Attach these to the Resolution Center reply.

## Why the Re-Rejection Likely Happened

Apple's rejection text is identical boilerplate to last week's. Most plausible explanations:

1. **Reviewer didn't re-test deeply.** Submission ID is the same as last week's (`9a67b871-2176-4a9f-bb56-df8efaab2f14`) — Apple may have processed the previous reply as "additional info, not material change" and re-rejected against the original finding. The previous reply was a single-paragraph commitment without verifiable URLs or screenshots.

2. **Reviewer interpreted per-seat $30/mo pricing as consumer pricing.** A single-seat clinic paying $30/month *looks* like a consumer SaaS subscription unless the surrounding context is unmistakably enterprise. The pricing page does say so, but a quick scan could miss it.

3. **The reviewed binary was "1.0 (6)"** despite our resubmission as `1.10.1` (build 5) — there may be an ASC version-management quirk where the listing's marketing version wasn't updated and reviewer was hitting an older record.

The fix path: a much stronger reply with verifiable evidence + an ASC metadata pass + (optional) one or two pricing-page polish edits in case Apple reads it again.

## Action Items (in order)

### A. Resolution Center reply — paste into ASC

Reply text (copy verbatim, attach 4 screenshots):

> Thank you for the additional review. We have made the architectural and policy commitments described in our prior reply concrete and externally verifiable. CaptiVet is a B2B enterprise service in both intent and implementation:
>
> **1. No self-serve registration exists — anywhere.**
> - Web app login (`https://app.captivet.com/login`): no "Sign up" or "Register" button. The only secondary action is *"Need access for your clinic? Request a demo"* (screenshot attached).
> - Web register routes (`/register`, `/signup`, `/sign-up`): client-side redirect to `/login`. There is no register UI.
> - Backend register endpoint (`https://api.captivet.com/auth/register`): rejects all unauthenticated requests with HTTP 401 `Missing authorization header`. Authenticated requests without a valid clinic-administrator invitation receive HTTP 403 `INVITATION_REQUIRED`.
> - iOS app sign-in screen: same — login-only, "Request a demo" link only.
>
> **2. Marketing site is B2B-only.**
> - Homepage (`https://captivet.com`): every call-to-action routes to `/book-a-demo/`. The hero displays a badge reading *"Clinic-only subscriptions · Admin-provisioned staff · BAA available"*.
> - Pricing page (`https://captivet.com/pricing/`): explicitly titled "Transparent per-seat pricing for licensed veterinary clinics". The FAQ states *"Your clinic administrator provisions each staff member… no self-serve signup is required."* All purchase paths route to a sales demo, not a payment page.
> - Educational access (`https://captivet.com/students/`): partnerships with AVMA-accredited veterinary schools only. Cohort access provisioned by the school administrator. The page explicitly states *"deployed only through school administrators — never self-serve"*.
>
> **3. Schema-level enforcement.**
> The `User.organizationId` field is non-nullable in our database schema. Every authenticated user is bound to a clinic organization at the data layer; there is no path through which an individual can hold an account without belonging to a provisioned organization.
>
> **4. No in-app billing infrastructure.**
> The mobile app does not link to, nor contain, any StoreKit / In-App Purchase libraries (`react-native-iap`, `expo-in-app-purchases`, etc.), no pricing UI, no subscription management UI, no payment forms. Billing happens exclusively through clinic-level direct contracts negotiated with our sales team.
>
> All four points above are independently verifiable by visiting the URLs cited or attempting the API calls described. We have attached screenshots documenting the absence of any consumer self-service path.
>
> CaptiVet is sold exclusively to licensed veterinary clinics under direct subscriptions, with access provisioned by clinic administrators. We respectfully request re-review under guideline 3.1.3(c) on this basis.
>
> If a written re-review is not the right path, we are also happy to schedule an App Review Appointment ("Meet with Apple") to walk through the architecture.

**Attach all four screenshots to the reply.**

### B. ASC metadata update (browser, ~5 minutes)

Login to App Store Connect → CaptiVet → App Information / current Version:

- **Subtitle** (max 30 chars): `For licensed veterinary clinics`
- **Description** (first paragraph): replace with:
  > CaptiVet is a clinical workflow tool for licensed veterinary clinics. Access is provisioned by clinic administrators after a direct subscription with our sales team. The app does not offer in-app purchases, free trials, or individual sign-ups.
- **Promotional text**: include "Clinic-administered access only. No in-app purchases."
- **Keywords**: drop "trial", "personal", "free", "student" (if any of these are in the keyword list); keep clinical / SOAP / DVM / veterinary / clinic terms.

### C. Verify ASC version mismatch

Apple reviewed "1.0 (6)" but `app.config.ts` is `1.11.0`. In ASC → App Store → CaptiVet, check:

- Is there an active "Version 1.0" record that should have been superseded by "Version 1.10.1" or "Version 1.11.0"?
- If yes, mark it superseded / removed before next submission so the listing version matches the binary's marketing string.

### D. (Optional polish) Pricing page edits — only if reply rejected again

If the reply path fails a second time, lightweight Bricks edits in a fresh `captivet-site` session:

- Replace "Cancel Anytime" badge → "Flexible clinic agreements" — sounds less consumer-y
- Pricing heading rewrite: "Plans for every practice." → "Pricing for licensed veterinary clinics."
- Add prominent banner above pricing tiers: *"Subscriptions are managed via our sales team. Click 'Request a Demo' to discuss pricing for your clinic."*

Don't pre-emptively do these — current site copy is sufficient evidence for the reply.

### E. (Optional polish) Fix dead "Sign In" button on captivet.com

Header "Sign In" button has no `href` (DOM: `<a id="brxe-hdrsig">` empty). Apple reviewer clicking it sees nothing happen — suggests broken site. Fix: link to `https://app.captivet.com/login`. ~30 seconds in Bricks. Not load-bearing but improves reviewer impression.

### F. (Optional) Fix /students hero contrast bug

Captured screenshot shows hero heading "Educational Access for Accredited Veterinary Schools" with very low contrast against background (looks like dark text on dark green). Reviewer might tag under accessibility. Separate cleanup, not load-bearing for the rejection.

### G. NO mobile rebuild needed

Do not bump version, do not rebuild, do not resubmit a binary. The Resolution Center reply alone re-queues the existing build for review. Re-submitting a binary without responding first re-queues the same complaint against the same evidence.

## What I Cannot Do (User Browser Tasks)

- **Post the reply in App Store Connect** — must be done by user logged into ASC.
- **Update ASC metadata** — same.
- **Verify version 1.0 vs 1.11.0 in ASC** — same.

## Decision Gate

If reply (A) + metadata (B) is rejected a third time:

- **Don't reply a fourth time blind.** Book "Meet with Apple" (offered in the rejection email) for a Tue/Thu slot. A 15-minute call resolves what 3 written replies couldn't.
- **Don't pre-emptively start IAP integration.** That's a multi-week build with revenue cost (15–30%); only worth it if direct conversation with Apple confirms IAP is the only acceptable path for our model.
