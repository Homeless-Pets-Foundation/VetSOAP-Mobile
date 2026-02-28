# VetSOAP Mobile — API Integration Guide

## Overview

VetSOAP Mobile is a lightweight recording client. Its only job is to:

1. Authenticate the user
2. Record an appointment (audio)
3. Upload the recording to the VetSOAP Connect API
4. Poll for status and display the resulting SOAP note

All transcription (Deepgram) and AI SOAP note generation (Google Gemini) happens server-side in VetSOAP Connect. The mobile app never touches those services directly.

```
┌─────────────────────┐         ┌─────────────────────────────────────────┐
│   VetSOAP Mobile    │         │        VetSOAP Connect (Railway)        │
│                     │         │                                         │
│  Record audio (.m4a)│         │  Express API ──► Trigger.dev Jobs       │
│  Upload to R2       │ ──────► │                    │                    │
│  Poll for status    │         │              ┌─────┴──────┐             │
│  Display SOAP note  │ ◄────── │              │            │             │
│                     │         │         Deepgram      Gemini            │
└─────────────────────┘         │        (transcribe)  (SOAP gen)         │
                                │              │            │             │
                                │              └─────┬──────┘             │
                                │                    ▼                    │
                                │              PostgreSQL DB              │
                                │              Cloudflare R2              │
                                └─────────────────────────────────────────┘
```

---

## Authentication

The mobile app authenticates through **Supabase Auth**, the same auth system the web app uses. Users log in with email + password. The resulting JWT is sent with every API request.

### Flow

1. User enters email + password on the login screen
2. Mobile calls `supabase.auth.signInWithPassword({ email, password })`
3. Supabase returns a session containing an `access_token` (JWT) and `refresh_token`
4. Tokens are stored securely on-device using `expo-secure-store` (Android Keystore / iOS Keychain)
5. Every API request includes the header: `Authorization: Bearer <access_token>`
6. The API validates the JWT by calling `supabase.auth.getUser(token)`, then looks up the user in its own database to get `organizationId`, `role`, etc.

### What the API attaches to each request

```
req.user = {
  id              — internal user UUID
  email
  supabaseUserId  — Supabase auth user ID
  role            — owner | admin | veterinarian | technician
  organizationId  — tenant isolation key
  isSuperAdmin    — platform-level admin flag
}
```

Every database query is scoped by `organizationId`, so users can only access their own organization's recordings.

### Token storage keys

| Key | Purpose |
|-----|---------|
| `vetsoap:access_token` | Supabase JWT for API calls |
| `vetsoap:refresh_token` | Used to refresh expired JWTs |

Supabase handles automatic token refresh via `autoRefreshToken: true`.

---

## Audio Recording

The mobile app records audio using `expo-av`, producing an AAC-encoded M4A file.

| Setting | Value |
|---------|-------|
| Format | `.m4a` (MPEG-4 container) |
| Codec | AAC |
| Sample rate | 44,100 Hz |
| Channels | 1 (mono) |
| Bitrate | 128 kbps |
| Typical size | ~1 MB per minute |

This format is natively supported by Deepgram (the transcription service on the backend), so no transcoding is needed.

The recording hook provides start/pause/resume/stop controls. After stopping, the audio is available as a local `file://` URI on the device.

---

## Upload Flow (Step by Step)

The mobile app uploads recordings through a **4-step presigned URL flow**. The audio file goes directly to Cloudflare R2 storage — it never passes through the API server.

```
Mobile App                      API Server                   Cloudflare R2
──────────                      ──────────                   ─────────────

1. POST /api/recordings ──────► Create record
   { patientName, species, ... } (status: "uploading")
                           ◄──── { id, status: "uploading" }

2. POST /api/recordings/:id ──► Generate presigned URL
   /upload-url                  via R2 SDK
   { fileName, contentType }
                           ◄──── { uploadUrl, fileKey }

3. PUT <uploadUrl> ─────────────────────────────────────────► Store .m4a file
   Body: audio blob                                           Key: recordings/{orgId}/{recordingId}.m4a
   Content-Type: audio/mp4
                                                         ◄──── 200 OK

4. POST /api/recordings/:id ──► Update record
   /confirm-upload              status → "uploaded"
   { fileKey }                  audioFileUrl = fileKey
                           ◄──── { id, status: "uploaded" }
```

### Step 1 — Create recording record

```
POST /api/recordings
Authorization: Bearer <token>
Content-Type: application/json

{
  "patientName": "Buddy",          ← required (1-100 chars)
  "clientName": "John Smith",      ← optional
  "species": "Canine",             ← optional
  "breed": "Golden Retriever",     ← optional
  "appointmentType": "Wellness Exam" ← optional
}
```

Response: a `Recording` object with `status: "uploading"`.

### Step 2 — Get presigned upload URL

```
POST /api/recordings/:id/upload-url
Authorization: Bearer <token>
Content-Type: application/json

{
  "fileName": "recording.m4a",
  "contentType": "audio/mp4",
  "fileSizeBytes": 5242880          ← optional, validated ≤ 500 MB
}
```

Response:

```json
{
  "uploadUrl": "https://<r2-endpoint>/recordings/org-id/rec-id.m4a?X-Amz-...",
  "fileKey": "recordings/org-id/rec-id.m4a"
}
```

The `uploadUrl` is a presigned PUT URL valid for **15 minutes**. Allowed content types: `audio/mpeg`, `audio/wav`, `audio/mp4`, `audio/webm`, `audio/ogg`, `audio/x-wav`, `audio/x-m4a`.

### Step 3 — Upload audio directly to R2

```
PUT <uploadUrl>
Content-Type: audio/mp4
Body: <binary audio data>
```

This request goes directly to Cloudflare R2, bypassing the API server entirely. The mobile app reads the local file URI as a blob and sends it.

### Step 4 — Confirm upload

```
POST /api/recordings/:id/confirm-upload
Authorization: Bearer <token>
Content-Type: application/json

{
  "fileKey": "recordings/org-id/rec-id.m4a"
}
```

The API validates the file key (alphanumeric + `/` + `.` only, no `..` path traversal), updates the recording to `status: "uploaded"`, and returns the updated record.

### File key format

```
recordings/{organizationId}/{recordingId}.{extension}
```

Example: `recordings/550e8400-e29b-41d4-a716-446655440000/abc123.m4a`

---

## Server-Side Processing (What Happens After Upload)

After the upload is confirmed, the API server's background job system (Trigger.dev) picks up the recording and processes it. The mobile app has no involvement in this — it just polls for status.

```
                              ┌──────────────────────────────────────────┐
                              │   process-recording job (Trigger.dev)    │
                              │   Max duration: 10 minutes               │
                              │   Retries: 3 (exponential backoff)       │
                              │                                          │
Status: "uploaded"            │                                          │
         │                    │                                          │
         ▼                    │                                          │
Status: "transcribing"  ──────┤  1. Download audio from R2               │
                              │  2. Send to Deepgram (nova-3 model)      │
                              │     - smart formatting                   │
                              │     - speaker diarization                │
                              │     - punctuation                        │
         │                    │                                          │
         ▼                    │  3. Store transcript text + confidence    │
Status: "transcribed"   ──────┤                                          │
                              │                                          │
         │                    │                                          │
         ▼                    │  4. Look up SOAP prompt templates        │
Status: "generating"    ──────┤  5. Send transcript + prompts to Gemini  │
                              │     (gemini-2.5-flash, temp=0.3)         │
                              │     Response format: JSON                │
         │                    │                                          │
         ▼                    │  6. Store SOAP note (4 sections)         │
Status: "completed"     ──────┤  7. Record usage for billing             │
                              │                                          │
         │                    └──────────────────────────────────────────┘
         ▼
    SOAP note available via GET /api/recordings/:id/soap-note


On error at any step:
Status: "failed"  ──── errorMessage stored (truncated to 500 chars)
```

### AI services used (server-side only)

| Service | Purpose | Model | Config |
|---------|---------|-------|--------|
| **Deepgram** | Audio transcription | nova-3 | smart format, diarize, punctuate |
| **Google Gemini** | SOAP note generation | gemini-2.5-flash | temp 0.3, top-p 0.8, JSON output |

Both services support **BYOK** (Bring Your Own Key) per organization. If an org has configured their own API keys (encrypted in the `ApiKey` table), those are used. Otherwise, platform-level keys are used.

---

## Polling for Status

After confirming the upload, the mobile app polls the recording endpoint to track processing progress.

```
GET /api/recordings/:id
Authorization: Bearer <token>
```

The mobile app uses React Query with adaptive polling:

```typescript
useQuery({
  queryKey: ['recording', id],
  queryFn: () => recordingsApi.get(id),
  refetchInterval: (query) => {
    const status = query.state.data?.status;
    // Poll every 5 seconds while processing
    if (status && !['completed', 'failed'].includes(status)) {
      return 5000;
    }
    // Stop polling once done
    return false;
  },
});
```

### Recording status lifecycle

```
uploading → uploaded → transcribing → transcribed → generating → completed
                                                                     │
                  (any step can fail) ───────────────────────► failed ─┘
```

| Status | Meaning |
|--------|---------|
| `uploading` | Record created, file not yet uploaded |
| `uploaded` | File in R2, waiting for processing job |
| `transcribing` | Deepgram is transcribing the audio |
| `transcribed` | Transcript ready, waiting for SOAP generation |
| `generating` | Gemini is generating the SOAP note |
| `completed` | SOAP note ready to view |
| `failed` | Processing failed (see `errorMessage` field) |

---

## Fetching the SOAP Note

Once the recording status is `completed`, the mobile app fetches the SOAP note:

```
GET /api/recordings/:id/soap-note
Authorization: Bearer <token>
```

Response:

```json
{
  "id": "soap-note-uuid",
  "recordingId": "recording-uuid",
  "subjective": {
    "content": "Owner reports that Buddy has been lethargic for 3 days...",
    "isEdited": false,
    "editedAt": null
  },
  "objective": {
    "content": "T: 101.5°F, HR: 80 bpm, RR: 20 breaths/min...",
    "isEdited": false,
    "editedAt": null
  },
  "assessment": {
    "content": "Suspect mild upper respiratory infection...",
    "isEdited": false,
    "editedAt": null
  },
  "plan": {
    "content": "1. Prescribe amoxicillin 250mg BID x 10 days...",
    "isEdited": false,
    "editedAt": null
  },
  "modelUsed": "gemini-2.5-flash",
  "promptTokens": 2500,
  "completionTokens": 1200,
  "generatedAt": "2026-02-27T15:30:45.123Z"
}
```

The mobile app displays these four sections in collapsible cards with copy-to-clipboard support.

---

## API Endpoints Used by Mobile

The mobile app uses a small subset of the full API. These are the only endpoints it calls:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/recordings` | Create a new recording record |
| `POST` | `/api/recordings/:id/upload-url` | Get presigned R2 upload URL |
| `PUT` | `<presigned R2 URL>` | Upload audio directly to R2 (not an API call) |
| `POST` | `/api/recordings/:id/confirm-upload` | Mark upload complete |
| `GET` | `/api/recordings` | List recordings (paginated) |
| `GET` | `/api/recordings/:id` | Get single recording (used for status polling) |
| `GET` | `/api/recordings/:id/soap-note` | Fetch the generated SOAP note |
| `POST` | `/api/recordings/:id/retry` | Retry failed processing |
| `GET` | `/api/users/me` | Fetch current user profile |

Endpoints **not used** by mobile (web-only): templates, organization settings, admin routes, super admin, billing, SOAP note editing, user management, API key management.

---

## Error Handling

### HTTP error codes

| Code | Meaning | Mobile behavior |
|------|---------|-----------------|
| 400 | Invalid input (Zod validation failed) | Show error message from `details` array |
| 401 | Token expired or invalid | Clear tokens, redirect to login |
| 403 | Insufficient permissions | Show permission error |
| 404 | Recording not found | Show "not found" message |
| 409 | Conflict (e.g., upload already confirmed) | Show conflict message |
| 429 | Rate limited (100 req/15 min) | Retry with backoff |
| 500+ | Server error | Retry with backoff |
| 503 | R2 storage not configured | Show setup required message |

### Failed recordings

When a recording's status is `failed`, the `errorMessage` field contains details. The mobile app shows a retry button that calls:

```
POST /api/recordings/:id/retry
```

This resets the status to `uploaded` so the background job picks it up again. Only recordings with `status: "failed"` can be retried.

---

## Rate Limits

| Route group | Limit | Window |
|-------------|-------|--------|
| `/api/*` | 100 requests | 15 minutes |
| `/admin/*` | Stricter (lower threshold) | 15 minutes |

Rate limits are per IP address. Exceeding the limit returns `429 Too Many Requests`.

---

## CORS

The API allows requests with no `Origin` header, which is how React Native on Android/iOS behaves. No CORS issues for mobile clients.

```javascript
// From apps/api/src/index.ts
origin: (origin, callback) => {
  if (!origin) {
    callback(null, true); // Allow mobile apps (no Origin header)
    return;
  }
  // ... whitelist check for web origins
}
```

---

## Security Boundaries

### What the mobile app handles

- Secure token storage (expo-secure-store → Android Keystore)
- Microphone permission management
- Local audio file lifecycle (record → upload → delete)
- TLS for all network requests

### What the API server handles

- JWT validation (Supabase)
- Organization-level tenant isolation (every query scoped by `organizationId`)
- Input validation (Zod schemas on all endpoints)
- File key sanitization (no path traversal)
- API key encryption (BYOK keys encrypted at rest with HKDF-derived keys)
- Rate limiting
- Presigned URL expiration (15 minutes)
- Prompt injection protection (transcript sanitization before sending to Gemini)

### What the mobile app does NOT do

- No direct Deepgram or Gemini API calls
- No database access
- No API key storage (all AI service keys are server-side)
- No audio transcoding (server accepts M4A natively)
- No SOAP prompt template management
- No organization or user administration

---

## Environment Configuration

### Mobile app (`.env`)

```bash
EXPO_PUBLIC_API_URL=https://<railway-api-domain>
EXPO_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<supabase-anon-key>
```

### API server (required for mobile upload flow)

```bash
# R2 storage (required for presigned upload URLs)
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<r2-access-key>
R2_SECRET_ACCESS_KEY=<r2-secret-key>
R2_BUCKET_NAME=vetsoap-recordings
```

---

## Complete End-to-End Timeline

```
Time    Mobile App                          API Server                       Background Job
─────   ──────────────────────────         ──────────────────────────       ─────────────────────────
0:00    User opens app
0:01    Login (Supabase)                   Validate JWT
0:02    Tap "Record"
0:02    expo-av starts recording
        (AAC, 44.1kHz, mono, 128kbps)
5:00    Tap "Stop" → .m4a saved locally
5:01    Fill patient form
5:05    Tap "Submit"
5:05    POST /api/recordings ──────────►   Create record (uploading)
5:05    POST /upload-url ──────────────►   Generate R2 presigned URL
5:06    PUT audio to R2 ─────────────────────────────────────────────►  (stored in R2)
5:08    POST /confirm-upload ──────────►   Status → uploaded
5:08    Start polling GET /:id
5:10                                                                    Job picks up recording
5:10                                                                    Status → transcribing
5:10                                                                    Download from R2
5:15                                                                    Deepgram transcribes
5:30                                                                    Status → transcribed
5:30                                                                    Status → generating
5:35                                                                    Gemini generates SOAP
5:40                                                                    SoapNote saved
5:40                                                                    Status → completed
5:40    Poll detects "completed"
5:40    GET /:id/soap-note ────────────►   Return SOAP note
5:41    Display S/O/A/P sections
```

Typical processing time: **1-2 minutes** from upload to completed SOAP note.
