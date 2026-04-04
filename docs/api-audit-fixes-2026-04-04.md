# API Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 13 API integration issues found during the upload → transcription → SOAP note audit across VetSOAP-Mobile and VetSOAP-Connect.

**Architecture:** Most fixes are isolated to two files on the mobile side (`src/api/recordings.ts`, `app/(app)/(tabs)/recordings/[id].tsx`) and one file on the server side (`apps/api/src/routes/recordings.ts`). Each task is self-contained and safe to apply individually.

**Tech Stack:** Expo / React Native (mobile), Node.js / Express / Prisma (server), Cloudflare R2 (storage), React Query (data fetching)

**Repos:**
- Mobile: `/home/philgood/projects/VetSOAP-Mobile`
- Server: `/home/philgood/projects/VetSOAP-Connect`

---

## Task 1: Normalize content type and filename consistency

**Issue:** `record.tsx` hardcodes `'audio/x-m4a'` as the content type, but the default parameter in `recordings.ts` `createWithFile`/`createWithSegments`/`getUploadUrl` is `'audio/mp4'`. The filename is always `recording.m4a`. This creates confusion about which type is canonical and what a caller should pass.

**Fix:** Change the default parameter in all three functions from `'audio/mp4'` to `'audio/x-m4a'` to match what `record.tsx` actually passes, and what iOS natively produces. The server already accepts both. No server change needed.

**Files:**
- Modify: `src/api/recordings.ts` (lines 90, 122, 214)

- [ ] **Step 1: Update the three default parameter values in recordings.ts**

Change `contentType = 'audio/mp4'` → `contentType = 'audio/x-m4a'` in three function signatures:

In `getUploadUrl` (line 90):
```typescript
async getUploadUrl(
  recordingId: string,
  fileName: string,
  contentType = 'audio/x-m4a',
  fileSizeBytes?: number
): Promise<UploadUrlResponse> {
```

In `createWithFile` (line 122):
```typescript
async createWithFile(
  data: CreateRecording,
  fileUri: string,
  contentType = 'audio/x-m4a',
  options?: { onUploadProgress?: (event: UploadProgressEvent) => void }
): Promise<Recording> {
```

In `createWithSegments` (line 214):
```typescript
async createWithSegments(
  data: CreateRecording,
  segments: { uri: string; duration: number }[],
  contentType = 'audio/x-m4a',
  options?: { onUploadProgress?: (event: UploadProgressEvent) => void }
): Promise<Recording> {
```

- [ ] **Step 2: Commit**

```bash
cd /home/philgood/projects/VetSOAP-Mobile
git add src/api/recordings.ts
git commit -m "fix: normalize content type default to audio/x-m4a"
```

---

## Task 2: Increase server presigned URL TTL from 15 to 30 minutes

**Issue:** Server generates presigned R2 URLs with a 900-second (15-minute) TTL. The mobile upload timeout is 600 seconds (10 minutes). On slow clinic WiFi a large file upload can take close to 10 minutes, leaving only a 5-minute window before the presigned URL expires. If the upload finishes just as the URL expires, R2 may reject it.

**Fix:** Increase TTL to 1800 seconds (30 minutes) in the server route.

**Files:**
- Modify: `/home/philgood/projects/VetSOAP-Connect/apps/api/src/routes/recordings.ts` (line 400)

- [ ] **Step 1: Find the TTL value**

```bash
grep -n "expiresIn" /home/philgood/projects/VetSOAP-Connect/apps/api/src/routes/recordings.ts
```

Expected output: `400:      expiresIn: 900,`

- [ ] **Step 2: Change TTL to 1800**

At line ~400 in the server recordings route, change:
```typescript
      expiresIn: 900,
```
to:
```typescript
      expiresIn: 1800,
```

- [ ] **Step 3: Commit**

```bash
cd /home/philgood/projects/VetSOAP-Connect
git add apps/api/src/routes/recordings.ts
git commit -m "fix: increase presigned URL TTL to 30 minutes"
```

---

## Task 3: Auto-retry SOAP note fetch on initial 404/error

**Issue:** When polling detects `status === 'completed'`, the SOAP note query is immediately enabled. There is a TOCTOU window where the server just transitioned to `completed` but has not yet committed the `SoapNote` row to the DB. The client gets a 404 or empty response and shows "SOAP note not available" — requiring a manual tap to retry.

**Fix:** Add `retry: 3` and a short `retryDelay` to the `soapNote` query in `[id].tsx` so React Query automatically retries 3 times with a 2-second delay before surfacing the error.

**Files:**
- Modify: `app/(app)/(tabs)/recordings/[id].tsx` (lines 145–155)

- [ ] **Step 1: Update the soapNote query to auto-retry**

Replace the existing `soapNote` query (around lines 145–155):
```typescript
  const {
    data: soapNote,
    isLoading: isSoapNoteLoading,
    isError: isSoapNoteError,
    refetch: refetchSoapNote,
    isRefetching: isRefetchingSoapNote,
  } = useQuery({
    queryKey: ['soapNote', id],
    queryFn: () => recordingsApi.getSoapNote(id!),
    enabled: !!id && recording?.status === 'completed',
  });
```

with:
```typescript
  const {
    data: soapNote,
    isLoading: isSoapNoteLoading,
    isError: isSoapNoteError,
    refetch: refetchSoapNote,
    isRefetching: isRefetchingSoapNote,
  } = useQuery({
    queryKey: ['soapNote', id],
    queryFn: () => recordingsApi.getSoapNote(id!),
    enabled: !!id && recording?.status === 'completed',
    retry: 3,
    retryDelay: 2000,
  });
```

- [ ] **Step 2: Commit**

```bash
cd /home/philgood/projects/VetSOAP-Mobile
git add "app/(app)/(tabs)/recordings/[id].tsx"
git commit -m "fix: auto-retry SOAP note fetch 3x with 2s delay on initial load"
```

---

## Task 4: Send Idempotency-Key header on recording create

**Issue:** If `POST /api/recordings` times out client-side (30 s) but was processed server-side, the mobile client retries and creates a duplicate recording. There is no deduplication mechanism.

**Fix:** Generate a UUID before the `create()` call and send it as an `Idempotency-Key` header. The server will use this to detect and return the existing recording on duplicate requests (Task 5 covers the server side).

**Files:**
- Modify: `src/api/client.ts` — add optional `idempotencyKey` to request config
- Modify: `src/api/recordings.ts` — generate and pass key in `createWithFile` and `createWithSegments`

- [ ] **Step 1: Add idempotencyKey support to ApiClient.request()**

In `src/api/client.ts`, update the `request()` method config type and header building:

```typescript
  async request<T>(
    path: string,
    config: {
      method?: string;
      body?: unknown;
      params?: Record<string, string | number | undefined>;
      timeoutMs?: number;
      idempotencyKey?: string;
    } = {}
  ): Promise<T> {
    const { method = 'GET', body, params, timeoutMs = REQUEST_TIMEOUT_MS, idempotencyKey } = config;
```

Then in `doFetch`, pass the key to the headers. Update the `doFetch` signature to accept it:

```typescript
  private async doFetch(
    url: string,
    method: string,
    path: string,
    serializedBody: string | undefined,
    timeoutMs: number,
    idempotencyKey?: string
  ): Promise<Response> {
    const authHeaders = await this.getAuthHeaders();
    if (this.cachedDeviceId === undefined) {
      const id = await secureStorage.getDeviceId();
      if (id) this.cachedDeviceId = id;
    }
    const deviceId = this.cachedDeviceId ?? null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      validateRequestUrl(url);

      if (__DEV__) console.log('[ApiClient]', method, path, 'hasToken:', !!authHeaders.Authorization);
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ...authHeaders,
          ...(deviceId ? { 'X-Device-Id': deviceId } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: serializedBody,
        signal: controller.signal,
      });

      if (__DEV__) console.log('[ApiClient]', method, path, 'status:', response.status);
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
```

Update both `doFetch` call sites in `request()` to pass the key:

```typescript
    let response = await this.doFetch(url, method, path, serializedBody, timeoutMs, idempotencyKey);
    // ...inside the 401 retry block:
        response = await this.doFetch(url, method, path, serializedBody, timeoutMs, idempotencyKey);
```

- [ ] **Step 2: Add a `post()` overload that accepts idempotencyKey**

In `src/api/client.ts`, update the `post()` helper:

```typescript
  post<T>(path: string, body?: unknown, idempotencyKey?: string) {
    return this.request<T>(path, { method: 'POST', body, idempotencyKey });
  }
```

- [ ] **Step 3: Generate idempotency key in recordings.ts create()**

In `src/api/recordings.ts`, update the `create()` method to generate a key:

```typescript
  async create(data: CreateRecording): Promise<Recording> {
    const validated = createRecordingSchema.parse(data);
    const idempotencyKey = generateIdempotencyKey();
    return apiClient.post('/api/recordings', validated, idempotencyKey);
  },
```

Add the `generateIdempotencyKey` helper at the top of the file (after imports):

```typescript
function generateIdempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
```

- [ ] **Step 4: Commit**

```bash
cd /home/philgood/projects/VetSOAP-Mobile
git add src/api/client.ts src/api/recordings.ts
git commit -m "feat: send Idempotency-Key header on recording create requests"
```

---

## Task 5: Server-side idempotency dedup for POST /api/recordings

**Issue:** Matching Task 4 on the server — when the same `Idempotency-Key` header is received within 60 seconds, return the existing recording instead of creating a duplicate.

**Fix:** Add an in-memory LRU-style Map to the server recordings route that caches `(userId, idempotencyKey) → recordingId` for 60 seconds. On duplicate key, fetch and return the existing recording.

**Files:**
- Modify: `/home/philgood/projects/VetSOAP-Connect/apps/api/src/routes/recordings.ts`

- [ ] **Step 1: Add idempotency cache near the top of the file (after imports)**

Find the constants block at the top of the recordings route file (around line 60–100) and add:

```typescript
// Idempotency dedup cache: maps `${userId}:${key}` → { recordingId, expiresAt }
// TTL is 60 seconds — covers client retry windows after network timeout
const IDEMPOTENCY_CACHE = new Map<string, { recordingId: string; expiresAt: number }>();
const IDEMPOTENCY_TTL_MS = 60_000;

function getIdempotencyEntry(userId: string, key: string): string | null {
  const cacheKey = `${userId}:${key}`;
  const entry = IDEMPOTENCY_CACHE.get(cacheKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    IDEMPOTENCY_CACHE.delete(cacheKey);
    return null;
  }
  return entry.recordingId;
}

function setIdempotencyEntry(userId: string, key: string, recordingId: string): void {
  const cacheKey = `${userId}:${key}`;
  IDEMPOTENCY_CACHE.set(cacheKey, { recordingId, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
  // Evict expired entries to prevent unbounded growth (runs lazily)
  if (IDEMPOTENCY_CACHE.size > 10_000) {
    const now = Date.now();
    for (const [k, v] of IDEMPOTENCY_CACHE) {
      if (now > v.expiresAt) IDEMPOTENCY_CACHE.delete(k);
    }
  }
}
```

- [ ] **Step 2: Add dedup logic to the POST /api/recordings handler**

Inside the `router.post('/', ...)` handler, before the `prisma.recording.create(...)` call, add:

```typescript
    // Idempotency check: if client retried with same key, return existing recording
    const idempotencyKey = typeof req.headers['idempotency-key'] === 'string'
      ? req.headers['idempotency-key'].slice(0, 128)
      : null;

    if (idempotencyKey) {
      const existingId = getIdempotencyEntry(req.user!.id, idempotencyKey);
      if (existingId) {
        const existing = await prisma.recording.findUnique({ where: { id: existingId } });
        if (existing) {
          res.status(200).json({ data: formatRecording(existing, null) });
          return;
        }
      }
    }
```

Then after the recording is created (`const recording = await prisma.recording.create(...)`), store it:

```typescript
    if (idempotencyKey) {
      setIdempotencyEntry(req.user!.id, idempotencyKey, recording.id);
    }
```

- [ ] **Step 3: Commit**

```bash
cd /home/philgood/projects/VetSOAP-Connect
git add apps/api/src/routes/recordings.ts
git commit -m "feat: server-side idempotency dedup for POST /api/recordings"
```

---

## Task 6: Derive segment filename from URI extension

**Issue:** Segment filenames are always `recording_segment_${i}.m4a` regardless of the actual file format. If expo-audio ever produces a different format (e.g., on specific Android builds), the filename extension disagrees with the content type.

**Fix:** Extract the extension from the actual segment URI and use it for the filename. Falls back to `.m4a` if the URI has no extension.

**Files:**
- Modify: `src/api/recordings.ts` (inside `createWithSegments`, line ~227)

- [ ] **Step 1: Add a URI-to-extension helper at the top of recordings.ts**

After the `generateIdempotencyKey` function (from Task 4), add:

```typescript
function extensionFromUri(uri: string, fallback = 'm4a'): string {
  const match = uri.split('?')[0].match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : fallback;
}
```

- [ ] **Step 2: Use the helper in createWithSegments**

In `createWithSegments`, change the segment filename from:
```typescript
        const segmentFileName = `recording_segment_${i}.m4a`;
```
to:
```typescript
        const ext = extensionFromUri(segment.uri);
        const segmentFileName = `recording_segment_${i}.${ext}`;
```

- [ ] **Step 3: Commit**

```bash
cd /home/philgood/projects/VetSOAP-Mobile
git add src/api/recordings.ts
git commit -m "fix: derive segment filename extension from actual URI"
```

---

## Task 7: Improve multi-segment failure error messages

**Issue:** If segment 5 of 10 fails, the error message says "Upload of segment 5 timed out" but all 10 segments are deleted and the entire recording is gone. Users lose all audio with no indication of how many segments were already safely uploaded or what to do.

**Fix:** Before deleting on multi-segment failure, surface which segments succeeded and give an actionable message. Since partial resume is architecturally complex, the improvement is in the error message quality — tell the user which segment failed, how many had already uploaded, and that they need to re-record.

**Files:**
- Modify: `src/api/recordings.ts` (inside `createWithSegments` catch block, line ~305)

- [ ] **Step 1: Track completed segments and enrich error messages**

In `createWithSegments`, add a counter before the loop:

```typescript
    let completedSegments = 0;
    for (let i = 0; i < totalSegments; i++) {
```

After `segmentKeys.push(fileKey);` (i.e., after a successful segment upload), increment:

```typescript
        segmentKeys.push(fileKey);
        completedSegments++;
```

In the catch block, wrap the error before re-throwing:

```typescript
    } catch (error) {
      if (!r2UploadComplete) {
        await this.delete(recording.id).catch(() => {});
      }
      // Enrich the error message for partial multi-segment failures
      if (completedSegments > 0 && completedSegments < totalSegments && error instanceof Error) {
        throw new Error(
          `${error.message} (${completedSegments} of ${totalSegments} segments had uploaded successfully — the recording has been removed and will need to be re-recorded.)`
        );
      }
      throw error;
    }
```

- [ ] **Step 2: Commit**

```bash
cd /home/philgood/projects/VetSOAP-Mobile
git add src/api/recordings.ts
git commit -m "fix: enrich multi-segment upload failure messages with segment progress"
```

---

## Task 8: Pause status polling when app is backgrounded

**Issue:** `refetchInterval: 10000` fires unconditionally every 10 seconds even when the app is in the background. For a 20-minute transcription job this results in 120 wasted background requests that drain battery and mobile data.

**Fix:** Track `AppState` in the recording detail screen and set `refetchInterval` to `false` when the app is not in the foreground.

**Files:**
- Modify: `app/(app)/(tabs)/recordings/[id].tsx`

- [ ] **Step 1: Add AppState tracking**

Add `AppState` to the React Native imports at the top of `[id].tsx`:

```typescript
import { View, Text, ScrollView, Pressable, Alert, RefreshControl, AppState } from 'react-native';
```

Add a `useState` import if not already present (it's used for `isAppActive`):

```typescript
import React, { useCallback, useState, useEffect, useRef } from 'react';
```

- [ ] **Step 2: Track app active state in the component**

Inside `RecordingDetailScreen`, add before the queries:

```typescript
  const appStateRef = useRef(AppState.currentState);
  const [isAppActive, setIsAppActive] = useState(AppState.currentState === 'active');

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      appStateRef.current = nextState;
      setIsAppActive(nextState === 'active');
    });
    return () => sub.remove();
  }, []);
```

- [ ] **Step 3: Gate refetchInterval on isAppActive**

Change the `recording` query's `refetchInterval`:

```typescript
    refetchInterval: (query) => {
      if (!isAppActive) return false;
      const status = query.state.data?.status;
      if (status && !['completed', 'failed', 'pending_metadata'].includes(status)) {
        return 10000;
      }
      return false;
    },
```

- [ ] **Step 4: Commit**

```bash
cd /home/philgood/projects/VetSOAP-Mobile
git add "app/(app)/(tabs)/recordings/[id].tsx"
git commit -m "fix: pause status polling when app is backgrounded"
```

---

## Task 9: Stop polling after 30 minutes of non-terminal status

**Issue:** If the server's processing job crashes silently and the recording stays in `transcribing` forever, the client polls indefinitely (until the user navigates away). There is no circuit breaker.

**Fix:** Record when polling started. If the recording has been in a non-terminal state for more than 30 minutes, stop polling and show a stale-processing warning with a manual retry button.

**Files:**
- Modify: `app/(app)/(tabs)/recordings/[id].tsx`

- [ ] **Step 1: Track polling start time**

Add a ref inside `RecordingDetailScreen` (alongside the AppState refs from Task 8):

```typescript
  const pollingStartedAtRef = useRef<number | null>(null);
```

- [ ] **Step 2: Update refetchInterval to enforce max polling duration**

Replace the `refetchInterval` logic (incorporating the Task 8 `isAppActive` guard):

```typescript
    refetchInterval: (query) => {
      if (!isAppActive) return false;
      const status = query.state.data?.status;
      if (!status || ['completed', 'failed', 'pending_metadata'].includes(status)) {
        pollingStartedAtRef.current = null;
        return false;
      }
      if (!pollingStartedAtRef.current) {
        pollingStartedAtRef.current = Date.now();
      }
      const elapsedMs = Date.now() - pollingStartedAtRef.current;
      if (elapsedMs > 30 * 60 * 1000) {
        return false; // Stop polling — stale processing
      }
      return 10000;
    },
```

- [ ] **Step 3: Show stale-processing warning in the UI**

Add a `isPollingStale` derived value after the queries:

```typescript
  const isPollingStale =
    !!pollingStartedAtRef.current &&
    Date.now() - pollingStartedAtRef.current > 30 * 60 * 1000 &&
    isProcessing;
```

In the JSX, after the `{isProcessing && ...}` card, add:

```typescript
        {isPollingStale && (
          <Card className="mx-5 mb-4 border-warning-200">
            <View className="flex-row items-start">
              <View className="mr-2 mt-0.5"><AlertTriangle color="#d97706" size={18} /></View>
              <View className="flex-1">
                <Text className="text-body font-semibold text-warning-700 mb-1">
                  Processing is taking longer than expected
                </Text>
                <Text className="text-body-sm text-stone-500 mb-2">
                  This may indicate a server issue. You can wait or retry processing.
                </Text>
                <View className="self-start">
                  <Button
                    variant="secondary"
                    size="sm"
                    onPress={() => retryMutation.mutate()}
                    loading={retryMutation.isPending}
                  >
                    Retry Processing
                  </Button>
                </View>
              </View>
            </View>
          </Card>
        )}
```

- [ ] **Step 4: Commit**

```bash
cd /home/philgood/projects/VetSOAP-Mobile
git add "app/(app)/(tabs)/recordings/[id].tsx"
git commit -m "fix: stop polling after 30 min and show stale-processing warning"
```

---

## Task 10: Show PARTIAL_GENERATION warning in recording detail

**Issue:** When SOAP note generation partially fails, the server marks the recording `completed` with `errorCode: 'PARTIAL_GENERATION'`. The mobile client renders the SOAP note without any indication that some sections may be missing or incomplete.

**Fix:** In the recording detail screen, when `status === 'completed'` AND `errorCode === 'PARTIAL_GENERATION'`, show a warning card above the SOAP note view.

**Files:**
- Modify: `app/(app)/(tabs)/recordings/[id].tsx`

- [ ] **Step 1: Add partial generation warning above the SOAP note**

In the JSX, find the `{recording.status === 'completed' && (...)}` block. Inside it, before the `{isSoapNoteLoading ? ...}` render block, add:

```typescript
            {recording.errorCode === 'PARTIAL_GENERATION' && (
              <Animated.View entering={FadeInUp.duration(300)} className="mb-4">
                <Card className="border-warning-200">
                  <View className="flex-row items-start">
                    <View className="mr-2 mt-0.5"><AlertTriangle color="#d97706" size={18} /></View>
                    <View className="flex-1">
                      <Text className="text-body font-semibold text-warning-700 mb-1">
                        Partial SOAP Note
                      </Text>
                      <Text className="text-body-sm text-stone-500 mb-2">
                        One or more sections could not be generated. The note below may be incomplete.
                      </Text>
                      <View className="self-start">
                        <Button
                          variant="secondary"
                          size="sm"
                          onPress={() => retryMutation.mutate()}
                          loading={retryMutation.isPending}
                        >
                          Regenerate
                        </Button>
                      </View>
                    </View>
                  </View>
                </Card>
              </Animated.View>
            )}
```

The full updated `completed` block becomes:

```typescript
        {recording.status === 'completed' && (
          <View className="px-5 pb-8">
            {recording.errorCode === 'PARTIAL_GENERATION' && (
              <Animated.View entering={FadeInUp.duration(300)} className="mb-4">
                <Card className="border-warning-200">
                  <View className="flex-row items-start">
                    <View className="mr-2 mt-0.5"><AlertTriangle color="#d97706" size={18} /></View>
                    <View className="flex-1">
                      <Text className="text-body font-semibold text-warning-700 mb-1">
                        Partial SOAP Note
                      </Text>
                      <Text className="text-body-sm text-stone-500 mb-2">
                        One or more sections could not be generated. The note below may be incomplete.
                      </Text>
                      <View className="self-start">
                        <Button
                          variant="secondary"
                          size="sm"
                          onPress={() => retryMutation.mutate()}
                          loading={retryMutation.isPending}
                        >
                          Regenerate
                        </Button>
                      </View>
                    </View>
                  </View>
                </Card>
              </Animated.View>
            )}
            {isSoapNoteLoading ? (
              ...existing skeleton...
```

- [ ] **Step 2: Commit**

```bash
cd /home/philgood/projects/VetSOAP-Mobile
git add "app/(app)/(tabs)/recordings/[id].tsx"
git commit -m "feat: show partial SOAP generation warning with regenerate button"
```

---

## Task 11: Fix DEVICE_REVOKED to not attempt token refresh

**Issue:** When the server returns `DEVICE_REVOKED` (401), `ApiClient.request()` calls `await this.onUnauthorized?.()` before throwing. `onUnauthorized` in `AuthProvider` attempts a Supabase token refresh. Since device revocation is API-layer (not auth-layer), the refresh succeeds, the new token is cached, and the next request gets `DEVICE_REVOKED` again. The user is never signed out automatically.

**File:**
- `src/api/client.ts`: lines 142–149

**Current code (lines ~142–149):**
```typescript
      if (errorPreview.code === 'DEVICE_REVOKED') {
        // Device was revoked by admin — force sign-out, no retry
        try { await this.onUnauthorized?.(); } catch { /* ignore */ }
        throw new ApiError(
          'This device has been revoked. Contact your administrator.',
          401,
          false
        );
      }
```

**Problem:** `onUnauthorized` triggers a token refresh (which succeeds), but does NOT force sign-out because the refresh succeeded. The user remains logged in with a revoked device.

**Fix:** Remove the `onUnauthorized` call for `DEVICE_REVOKED`. Instead, add a dedicated `onDeviceRevoked` callback that forces sign-out directly. Register this callback in `AuthProvider`.

- [ ] **Step 1: Add onDeviceRevoked callback to ApiClient**

In `src/api/client.ts`, update the class:

```typescript
export class ApiClient {
  private onUnauthorized?: () => void | Promise<void>;
  private onDeviceRevoked?: () => void | Promise<void>;
  private currentToken: string | null = null;
  private cachedDeviceId: string | undefined = undefined;

  constructor(opts?: { onUnauthorized?: () => void | Promise<void>; onDeviceRevoked?: () => void | Promise<void> }) {
    this.onUnauthorized = opts?.onUnauthorized;
    this.onDeviceRevoked = opts?.onDeviceRevoked;
  }

  setOnUnauthorized(callback: () => void | Promise<void>) {
    this.onUnauthorized = callback;
  }

  setOnDeviceRevoked(callback: () => void | Promise<void>) {
    this.onDeviceRevoked = callback;
  }
```

Update the `DEVICE_REVOKED` branch to call `onDeviceRevoked` instead of `onUnauthorized`:

```typescript
      if (errorPreview.code === 'DEVICE_REVOKED') {
        // Device was revoked by admin — force sign-out without refresh
        try { await this.onDeviceRevoked?.(); } catch { /* ignore */ }
        throw new ApiError(
          'This device has been revoked. Contact your administrator.',
          401,
          false
        );
      }
```

- [ ] **Step 2: Register onDeviceRevoked in AuthProvider**

In `src/auth/AuthProvider.tsx`, find where `apiClient.setOnUnauthorized(...)` is called (likely in a `useEffect` that runs once). Add alongside it:

```typescript
    apiClient.setOnDeviceRevoked(() => {
      handleSignOut().catch(() => {});
    });
```

- [ ] **Step 3: Verify handleSignOut is accessible at that call site**

`handleSignOut` should already be defined in scope. If it's not (e.g., it's defined after the effect), move the `setOnDeviceRevoked` call to after `handleSignOut` is defined, or pass a ref.

- [ ] **Step 4: Commit**

```bash
cd /home/philgood/projects/VetSOAP-Mobile
git add src/api/client.ts src/auth/AuthProvider.tsx
git commit -m "fix: DEVICE_REVOKED forces sign-out without attempting token refresh"
```

---

## Task 12: Increase proactive token refresh buffer from 5 to 10 minutes

**Issue:** `AuthProvider` proactively refreshes the token when foreground-resuming if the session expires within 300 seconds (5 minutes). If the app is backgrounded for 55+ minutes, the token can expire and active polling requests get 401s, triggering reactive refresh mid-request. Increasing the buffer to 600 seconds (10 minutes) gives more headroom.

**File:**
- `src/auth/AuthProvider.tsx` — the `handleAppStateChange` effect

- [ ] **Step 1: Find the buffer constant**

```bash
grep -n "bufferSeconds\|300" /home/philgood/projects/VetSOAP-Mobile/src/auth/AuthProvider.tsx | head -10
```

- [ ] **Step 2: Increase bufferSeconds to 600**

In the `handleAppStateChange` function inside the `useEffect` for app state, change:
```typescript
      const bufferSeconds = 300;
```
to:
```typescript
      const bufferSeconds = 600;
```

- [ ] **Step 3: Commit**

```bash
cd /home/philgood/projects/VetSOAP-Mobile
git add src/auth/AuthProvider.tsx
git commit -m "fix: increase proactive token refresh buffer from 5 to 10 minutes"
```

---

## Task 13: Add R2_BUCKET_HOSTNAME to CONFIG_MISSING tracking

**Issue:** `EXPO_PUBLIC_R2_BUCKET_HOSTNAME` is optional in `config.ts` — missing it only logs a `console.warn`. In production, `validateUploadUrl()` is fail-closed (throws if hostname not set). But there is no `CONFIG_MISSING` flag for this, so the app's layout guard (`app/_layout.tsx`) won't block startup or show a clear error screen when the hostname is missing. A developer who forgets to set this in a production build sees silent upload failures, not a startup error.

**Fix:** Treat `EXPO_PUBLIC_R2_BUCKET_HOSTNAME` as required in production builds (when not `__DEV__`) and include it in `CONFIG_MISSING` tracking. Keep the soft behavior in dev.

**File:**
- `src/config.ts`

- [ ] **Step 1: Gate R2_BUCKET_HOSTNAME on build type in config.ts**

Replace the current soft R2 hostname block:
```typescript
// Specific R2 bucket hostname for upload URL validation (e.g. "<account-id>.r2.cloudflarestorage.com")
// Soft default — missing hostname weakens upload URL validation but doesn't brick the app.
export const R2_BUCKET_HOSTNAME = process.env.EXPO_PUBLIC_R2_BUCKET_HOSTNAME || '';

if (!R2_BUCKET_HOSTNAME) {
  console.warn(
    '[Config] EXPO_PUBLIC_R2_BUCKET_HOSTNAME is not set. ' +
    'Upload URL validation will be weaker (HTTPS + signature only).'
  );
}
```

with:
```typescript
// Specific R2 bucket hostname for upload URL validation (e.g. "<account-id>.r2.cloudflarestorage.com")
// Required in production — missing hostname causes fail-closed upload validation (all uploads rejected).
// In dev, missing hostname weakens validation to HTTPS + signature only.
export const R2_BUCKET_HOSTNAME = __DEV__
  ? (process.env.EXPO_PUBLIC_R2_BUCKET_HOSTNAME || '')
  : requireValue('EXPO_PUBLIC_R2_BUCKET_HOSTNAME', process.env.EXPO_PUBLIC_R2_BUCKET_HOSTNAME);

if (__DEV__ && !R2_BUCKET_HOSTNAME) {
  console.warn(
    '[Config] EXPO_PUBLIC_R2_BUCKET_HOSTNAME is not set. ' +
    'Upload URL validation will be weaker in dev (HTTPS + signature only). ' +
    'This will block all uploads in a production build.'
  );
}
```

- [ ] **Step 2: Verify requireValue is already defined**

```bash
grep -n "function requireValue" /home/philgood/projects/VetSOAP-Mobile/src/config.ts
```

Expected: `20:function requireValue(name: string, value: string | undefined): string {`

- [ ] **Step 3: Commit**

```bash
cd /home/philgood/projects/VetSOAP-Mobile
git add src/config.ts
git commit -m "fix: require R2_BUCKET_HOSTNAME in production builds via CONFIG_MISSING"
```

---

## Execution Order

Tasks are independent and can be executed in any order. Recommended sequence:

1. Task 1 (MIME type) — zero-risk, one-liner
2. Task 2 (server TTL) — zero-risk, one-liner on server
3. Task 13 (R2 config) — zero-risk, config.ts only
4. Task 12 (token buffer) — zero-risk, one number change
5. Task 11 (device revocation) — medium — touches AuthProvider
6. Task 6 (segment filename) — zero-risk, new helper
7. Task 7 (segment errors) — zero-risk, error message improvement
8. Task 3 (SOAP retry) — zero-risk, adds query option
9. Task 10 (partial SOAP UI) — UI addition only
10. Task 8 (background polling) — medium — adds AppState dependency
11. Task 9 (max polling) — depends on Task 8 being in place
12. Task 4 (idempotency client) — medium — touches client.ts
13. Task 5 (idempotency server) — medium — touches server route

## Audit Checklist (run after all tasks complete)

- [ ] `grep -n "contentType = 'audio/mp4'" src/api/recordings.ts` → 0 results
- [ ] `grep -n "expiresIn" /home/philgood/projects/VetSOAP-Connect/apps/api/src/routes/recordings.ts` → shows `1800`
- [ ] SOAP note query has `retry: 3, retryDelay: 2000`
- [ ] `Idempotency-Key` header appears in `doFetch` headers
- [ ] Idempotency cache functions exist in server recordings route
- [ ] `extensionFromUri` helper exists in `recordings.ts`
- [ ] `completedSegments` variable tracks multi-segment progress
- [ ] `isAppActive` state and AppState listener in `[id].tsx`
- [ ] `pollingStartedAtRef` and 30-min guard in `[id].tsx`
- [ ] `PARTIAL_GENERATION` warning card in `[id].tsx`
- [ ] `setOnDeviceRevoked` in `ApiClient`, `onDeviceRevoked` in `AuthProvider`
- [ ] `bufferSeconds = 600` in `AuthProvider`
- [ ] `requireValue` used for `R2_BUCKET_HOSTNAME` in production path in `config.ts`
