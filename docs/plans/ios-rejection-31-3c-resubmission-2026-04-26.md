# iOS Re-Rejection 3.1.3(c) — Path to Resubmission

## Context

Apple re-rejected v1.0 (build 6) on 2026-04-26 (iPad Air 11" M3) under **guideline 3.1.1 / 3.1.3(c)** — enterprise services rule. Submission ID `9a67b871-2176-4a9f-bb56-df8efaab2f14`. Mic-button (5.1.1(iv)) and iPad screenshots (2.3.3) from prior rejection are resolved — only the IAP/enterprise rule remains.

**Why the first reply didn't work:** Last week we promised Apple two follow-ups: (1) gate web account creation, (2) update ASC metadata to emphasize B2B. Only #1 shipped. The marketing site at captivet.com still pushes consumer-facing self-serve:

- Homepage CTA: **"Start Free Trial"** (amber button, no clinic verification)
- Pricing page: **"Plans from $49/month for solo practitioners…"**
- `/students` page: **"Free for Veterinary Students"** — direct individual access
- No "Book a demo / contact sales" enterprise gating on the public site

An Apple reviewer landing on captivet.com sees a SaaS that sells to individuals, regardless of what the in-app `/sign-up` does. That contradicts our B2B-only reply.

VetSOAP-Connect side IS clean:
- `apps/api/src/routes/auth.ts` returns 403 `INVITATION_REQUIRED` for any uninvited registration (commit `c424d81` on 2026-04-23)
- `apps/expo/app/(auth)/register.tsx` redirects to `/login`
- Login page shows "Need access for your clinic? Request a demo"

Goal: ship the marketing-site B2B re-positioning + ASC metadata update + a stronger Resolution Center reply with evidence, so re-review passes without an IAP build (which is multi-week and would cost 30%/15% Apple cut).

## Recommended Path: Reply + Marketing Fixes (NOT IAP)

Reasoning is unchanged from `apple_review_compliance.md`: VetSOAP has zero IAP infrastructure (no `react-native-iap`/StoreKit, `User.organizationId` is non-nullable, no in-app billing UI). The reply path remains correct — we just need to **execute the follow-ups we already promised**.

If this second reply also fails, the fallback is an IAP build (separate plan, multi-week). Don't preemptively start IAP work.

## Work Items

### 1. captivet-site (WordPress/Bricks) — remove consumer signals — **PRIMARY FIX**

This is the load-bearing change. Without it, every reply will fail.

- Replace **"Start Free Trial"** CTAs with **"Book a Demo"** or **"Request Access"** site-wide. Header, hero, pricing cards, footer. Use Bricks global element if one exists; else page-by-page edit.
- Remove or rewrite **`/students`** page: either delete the page, or rewrite as "Veterinary student program — schools partner with CaptiVet to provision student access through faculty advisors" (reframes as institutional channel, not free individual access).
- Pricing page: drop **"Plans from $49/month for solo practitioners"** language. Replace with "Custom plans for clinics — contact us for pricing." Remove self-serve "Sign up" buttons; replace with "Schedule consultation."
- Hero subhead + meta description: explicitly say "**Built for licensed veterinary clinics**" and "**Sold via direct contracts**" so the first sentence Apple reads is unambiguous.
- Footer / nav: remove any "Login" link that lands on a consumer-style sign-up; keep clinic-staff login.
- Use Bricks MCP design intake → build/update flow per CLAUDE.md, but the changes are content-only; no new pages.

**Verification:** open captivet.com in incognito on desktop + mobile, walk every CTA, verify no path leads to a self-serve signup or an "individual / free trial / student free access" claim. Screenshot the homepage, pricing, and `/students` page (post-fix) — these go in the Resolution Center reply.

### 2. App Store Connect metadata — emphasize B2B (no code change)

In ASC → App Information / Version Information:

- **Subtitle:** "For licensed veterinary clinics" (or similar; max 30 chars)
- **Description (first paragraph):** "CaptiVet is a clinical workflow tool for licensed veterinary clinics. Access is provisioned by clinic administrators after a direct subscription with our sales team. The app does not offer in-app purchases, free trials, or individual sign-ups."
- **Promotional text:** mention clinic-only access
- **Keywords:** drop any "personal", "free", "trial", "student" if present; keep clinical / SOAP / DVM terms

User does this in browser; not a code change. Do NOT block on this — can be done in parallel with #1.

### 3. Resolution Center reply — second attempt with evidence

Reply in App Store Connect referencing the prior message. Stronger and more specific this time. Draft:

> Thank you for the additional review. We have addressed the concern materially, not only in policy but in implementation:
>
> 1. **Web sign-up is invitation-only.** Our backend (`/auth/register` endpoint) returns HTTP 403 `INVITATION_REQUIRED` for any registration attempt without a pending clinic-administrator invitation. There is no consumer self-service registration path — neither in the mobile app nor on the web — period. (Verifiable by attempting to register at captivet.com.)
>
> 2. **Marketing site repositioned to B2B-only.** captivet.com no longer offers self-serve trials, individual pricing, or student free access. All public CTAs route to "Book a Demo" or sales contact. Pricing is custom-quoted via our sales team only.
>
> 3. **App Store listing updated.** Subtitle and description now explicitly state the app is for licensed veterinary clinics and that access is provisioned by clinic administrators under direct subscriptions.
>
> 4. **Architectural enforcement.** The `User.organizationId` field is non-nullable in the database schema — every authenticated user is bound to a clinic organization at the data layer. There is no in-app billing UI, no StoreKit / IAP libraries, and no path for an individual or family to obtain access without going through a clinic-administered subscription.
>
> CaptiVet is a B2B enterprise service in both intent and implementation. We respectfully request re-review. We are also happy to schedule an App Review Appointment ("Meet with Apple") if helpful.

Attach screenshots (post-#1) of the captivet.com homepage + pricing page + the in-app sign-in screen showing "Request a demo" link.

### 4. Optional: request "Meet with Apple" appointment

The rejection letter explicitly offers this. If reply #2 also fails, book a Tuesday/Thursday appointment instead of replying again — speaks faster than a third written reply.

### 5. Mobile app version + resubmit

Once #1 + #2 ship and reply is posted:

- Build is **already** at `1.11.0` in `app.config.ts` (current `main`, post `ef7a04a`). EAS auto-increments build number.
- No code change needed in the mobile repo for this rejection class.
- Run `npx expo-doctor` (pre-build hook gates this), then `eas build --platform ios --profile production --non-interactive`, then `eas submit --platform ios --latest --non-interactive` (submit.production.ios is now wired per `44203b3`, so non-interactive works).

Note: ASC is showing the latest review as **"1.0 (6)"** despite memory recording 1.10.1 (5) as the prior submission. Suspect ASC has not been told the marketing version on the latest binary; verify in ASC → App Store → Version 1.11.0 before submitting again. If a stale 1.0 record exists, remove or supersede it.

## Critical Files / Locations

| Item | Path |
|---|---|
| Marketing site (WordPress/Bricks) | `/home/philgood/projects/captivet-site` |
| Web app signup gate (already shipped) | `VetSOAP-Connect/apps/api/src/routes/auth.ts` |
| Web register redirect | `VetSOAP-Connect/apps/expo/app/(auth)/register.tsx` |
| Mobile version | `app.config.ts` (currently `1.11.0`) |
| EAS submit config | `eas.json` (`submit.production.ios` wired) |
| ASC metadata | App Store Connect web UI — **not in repo** |
| Existing reply template | memory `apple_review_compliance.md` |
| Resubmission flow | memory `ios_build.md` |

## Verification — End-to-End

1. **Marketing site** — incognito browse captivet.com on desktop + mobile after #1 ships. Confirm zero "Free Trial / $49 / individual / student-free" copy. Screenshots saved for reply attachment.
2. **Web register endpoint** — `curl -X POST https://api.captivet.com/auth/register -d '{"email":"x@x.com","password":"x"}'` → expect HTTP 403 `INVITATION_REQUIRED`. (Already true.)
3. **In-app sign-in** — open production iOS build, confirm no sign-up CTA, only sign-in + "Request a demo" link.
4. **ASC listing** — preview the App Store listing in ASC, verify subtitle + description first paragraph match the B2B language above.
5. **Resolution Center** — confirm reply posted with screenshots before triggering re-review (re-submitting a binary without replying re-queues the same complaint).
6. **Build + submit** — run `eas build --platform ios --profile production --non-interactive`, then `eas submit --platform ios --latest --non-interactive`. Watch ASC for "Waiting for Review" → "In Review" → outcome.

## Order of Operations

The order matters. Do not flip:

1. Fix captivet.com copy (#1) — biggest risk surface
2. Update ASC metadata (#2) — instant, parallel
3. Take fresh screenshots of fixed site
4. Post Resolution Center reply (#3) with screenshots
5. (No mobile rebuild needed unless ASC version cleanup forces one — see #5 caveat)
6. Wait for re-review (typical 24–48h)
7. If rejected again → book "Meet with Apple" (#4), don't reply a third time blind

## Out of Scope

- IAP / StoreKit integration — only revisit if reply #2 also fails
- Mobile-side code changes — none required for this rejection class
- New marketing site features — content-only changes to existing pages
- VetSOAP-Connect changes — already compliant
