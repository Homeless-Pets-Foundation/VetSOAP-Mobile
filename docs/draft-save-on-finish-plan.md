# Plan: Auto-Save Draft on Finish

## Context

Staff close the app on the recording screen (accidentally or intentionally) and lose the recording entirely — because audio is only held in-memory state until explicitly submitted. There is a manual "Save for Later" stash, but staff don't know to use it and the recording doesn't appear in Recent Recordings or the Recordings tab.

**Goal:** When staff tap "Finish" on a patient recording, auto-save it as a server-side draft that appears in all existing listings as "Not Submitted." Tapping that card navigates back to the record screen with the session pre-loaded, ready to submit. Audio is persisted locally first (offline resilience), then a server record with `status='draft'` is created when online.

---

## Decisions

- **Offline first:** Audio moves to persistent device storage on Finish regardless of connectivity. Server draft is created when online; pending-sync is retried on reconnect.
- **Server-side draft status:** A new `'draft'` status is added to the RecordingStatus enum. Drafts appear in server-fetched Recent Recordings and Recordings lists naturally — no UI data-merging required.
- **Per-patient granularity:** Each patient's Finish tap triggers its own independent draft save.
- **Missing audio on tap:** Alert with option to re-record using pre-filled form data.
- **Draft cleanup:** `draftStorage.deleteDraft()` called after successful submit or sign-out PHI wipe.

---

## Files to Modify / Create

### Server — VetSOAP-Connect (`/home/philgood/projects/VetSOAP-Connect`)

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add `draft` to `RecordingStatus` enum |
| Recordings router/service (find via `grep -r "RecordingStatus" src/`) | Accept optional `isDraft: boolean` on create; skip processing queue when true; allow `draft → uploading` transition in confirmUpload |

Run `npx prisma db push` (or migration) after schema change.

### Client — VetSOAP-Mobile

| File | Change |
|------|--------|
| `src/types/index.ts` | Add `'draft'` to `RecordingStatus` union |
| `src/types/multiPatient.ts` | Add `draftSlotId: string \| null` and `serverDraftId: string \| null` to `PatientSlot`; add `SET_DRAFT_IDS` to `SessionAction` |
| `src/lib/draftStorage.ts` | **New file** — local draft persistence (see spec below) |
| `src/api/recordings.ts` | `create()` accepts `isDraft?: boolean`; `createWithFile()` / `createWithSegments()` accept `existingRecordingId?: string` to skip the create step |
| `src/auth/AuthProvider.tsx` | `fetchUser()`: call `draftStorage.setUserId(userId)`; `handleSignOut()`: add `draftStorage.clearAll()` to PHI cleanup `Promise.all` |
| `src/hooks/useMultiPatientSession.ts` | Handle `SET_DRAFT_IDS` action in reducer (sets `draftSlotId` + `serverDraftId` on the matching slot) |
| `app/(app)/(tabs)/record.tsx` | Auto-save after `saveAudio()`; skip `create()` in `uploadSlot()` if `serverDraftId` set; load draft from route param on mount; pending-sync banner; `deleteDraft()` on submit success |
| `src/components/RecordingCard.tsx` | "Not Submitted" amber badge for `'draft'` status; navigate to `/(tabs)/record?draftSlotId=X` instead of detail screen |
| `app/(app)/(tabs)/index.tsx` | Load `draftStorage.listDrafts()` on mount; pass `localDraftSlotId` to RecordingCard for draft entries |
| `app/(app)/(tabs)/recordings/index.tsx` | Same as above |

---

## Implementation Steps

### Step 1 — Server: add `draft` status
1. In `prisma/schema.prisma`, add `draft` to the `RecordingStatus` enum.
2. In the recordings service `create()` method, accept `isDraft: boolean`. When true, set `status = 'draft'` and do **not** enqueue the transcription/SOAP job.
3. In `confirmUpload()`, allow the transition `draft → uploading` (alongside the existing `uploading → uploaded` transition logic).
4. Run `npx prisma db push` (dev) or create a migration for production.

### Step 2 — Client types
1. `src/types/index.ts`: add `'draft'` to `RecordingStatus`.
2. `src/types/multiPatient.ts`:
   - Add to `PatientSlot`: `draftSlotId: string | null` (init `null`), `serverDraftId: string | null` (init `null`)
   - Add `SessionAction`: `{ type: 'SET_DRAFT_IDS'; slotId: string; draftSlotId: string; serverDraftId: string | null }`

### Step 3 — New `src/lib/draftStorage.ts`
Mirror the pattern of `stashStorage.ts`. Key points:
- `setUserId(userId)` — must be called before any operation; scopes all keys to user
- `saveDraft(slot)` — moves each `segment.uri` from cache to `documentDirectory/drafts/{userId}/{slotId}/seg_{n}.m4a` using `FileSystem` copy + delete; writes `DraftMetadata` to SecureStore at key `draft_{userId}_{slotId}`; **always sets `pendingSync: true`** (server creation hasn't happened yet); returns `draftSlotId` (= `slot.id`)
- `updateServerDraftId(slotId, serverId)` — reads SecureStore entry, sets `serverDraftId` and `pendingSync: false`, writes back
- `getDraft(slotId)` — returns `DraftMetadata | null`
- `listDrafts()` — returns all `DraftMetadata[]` for current user
- `deleteDraft(slotId)` — deletes audio files via `safeDeleteDirectory` + removes SecureStore key
- `clearAll()` — deletes all drafts for current user (sign-out cleanup)
- `syncPending()` — finds all drafts with `pendingSync: true`, calls `recordingsApi.create(draft.formData, { isDraft: true })`, updates `serverDraftId` via `updateServerDraftId()`

```typescript
interface DraftMetadata {
  slotId: string
  savedAt: string                              // ISO
  formData: CreateRecording
  segments: { uri: string; duration: number }[] // persistent paths
  audioDuration: number
  serverDraftId: string | null
  pendingSync: boolean
}
```

All SecureStore calls wrapped in try/catch (per CLAUDE.md rule 3). Audio moves must use `safeDeleteFile` from `src/lib/fileOps.ts`.

### Step 4 — `src/api/recordings.ts`
1. `create(data, options?: { isDraft?: boolean })` — pass `isDraft` in the POST body when true.
2. `createWithFile(data, fileUri, contentType, options?: { existingRecordingId?: string; onUploadProgress? })`:
   - If `existingRecordingId` is supplied, skip the internal `create()` call; use `existingRecordingId` for `getUploadUrl` and `confirmUpload`.
3. `createWithSegments(data, segments, contentType, options?: { existingRecordingId?: string; onUploadProgress? })`: same skip logic.

### Step 5 — `src/auth/AuthProvider.tsx`
1. In `fetchUser()`, after existing `setStashUserId(userId)` call: `draftStorage.setUserId(userId)`.
2. In `handleSignOut()`, in the `Promise.all` cleanup array: add `draftStorage.clearAll().catch(() => {})`.

### Step 6 — `src/hooks/useMultiPatientSession.ts`
Add reducer case for `SET_DRAFT_IDS`:
```typescript
case 'SET_DRAFT_IDS':
  return {
    ...state,
    slots: state.slots.map(s =>
      s.id === action.slotId
        ? { ...s, draftSlotId: action.draftSlotId, serverDraftId: action.serverDraftId }
        : s
    ),
  }
```

### Step 7 — `app/(app)/(tabs)/record.tsx`

**A. Auto-save after `saveAudio()` in the stopped-state effect:**

`isConnected` comes from `useNetInfo()` (from `@react-native-community/netinfo` — check if already installed; if not, use `expo-network`'s `getNetworkStateAsync()`). Add to the top of `record.tsx`.

```typescript
// After existing saveAudio() call:
autoSaveDraft(slot).catch(() => {}) // never throws to caller

async function autoSaveDraft(slot: PatientSlot) {
  // saveDraft() always sets pendingSync: true initially
  const draftSlotId = await draftStorage.saveDraft(slot)
  dispatch({ type: 'SET_DRAFT_IDS', slotId: slot.id, draftSlotId, serverDraftId: null })
  if (isConnected) {
    const result = await recordingsApi.create(slot.formData, { isDraft: true })
    dispatch({ type: 'SET_DRAFT_IDS', slotId: slot.id, draftSlotId, serverDraftId: result.id })
    // updateServerDraftId also sets pendingSync: false
    await draftStorage.updateServerDraftId(draftSlotId, result.id)
  }
  // if offline: pendingSync stays true; retried in syncPending() on reconnect
}
```

**B. `uploadSlot()` — skip create if `serverDraftId` present:**
```typescript
const result = slot.serverDraftId
  ? await recordingsApi.createWithFile(slot.formData, audioUri, 'audio/x-m4a', {
      existingRecordingId: slot.serverDraftId,
      onUploadProgress,
    })
  : await recordingsApi.createWithFile(slot.formData, audioUri, 'audio/x-m4a', { onUploadProgress })

// After success:
if (slot.draftSlotId) {
  draftStorage.deleteDraft(slot.draftSlotId).catch(() => {})
}
```

**C. Load draft on mount from route param (`draftSlotId` search param):**

Guard: if the current session already has unsaved recordings (`unsavedCount > 0`), confirm before overwriting.

```typescript
const { draftSlotId } = useLocalSearchParams<{ draftSlotId?: string }>()

useEffect(() => {
  if (!draftSlotId) return
  ;(async () => {
    // Guard: don't silently wipe an active session
    if (unsavedCount > 0) {
      Alert.alert(
        'Replace Current Session?',
        'You have unsaved recordings in progress. Loading this draft will discard them.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Load Draft', style: 'destructive', onPress: () => loadDraft(draftSlotId) },
        ]
      )
      return
    }
    await loadDraft(draftSlotId)
  })().catch(() => {})
}, [draftSlotId])

async function loadDraft(slotId: string) {
  const draft = await draftStorage.getDraft(slotId)
  if (!draft) { Alert.alert('Draft not found'); return }
  // validate all segment files exist
  for (const seg of draft.segments) {
    const info = await FileSystem.getInfoAsync(seg.uri)
    if (!info.exists) {
      Alert.alert(
        'Audio Not Found',
        'The recording audio was not found on this device. Would you like to start a new recording with the same patient details pre-filled?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Re-record',
            onPress: () => {
              // Delete server draft + local draft, reset session, add fresh slot with pre-filled form
              recordingsApi.delete(draft.serverDraftId).catch(() => {})
              draftStorage.deleteDraft(slotId).catch(() => {})
              dispatch({ type: 'RESET_SESSION' })
              dispatch({ type: 'ADD_SLOT', formData: draft.formData })
              // Navigate to clear the param so this effect doesn't re-fire
              router.replace('/(tabs)/record')
            },
          },
        ]
      )
      return
    }
  }
  // All files present — restore into session
  const restoredSlot: PatientSlot = {
    id: draft.slotId,
    formData: draft.formData,
    audioState: 'stopped',
    segments: draft.segments,
    audioUri: draft.segments.at(-1)?.uri ?? null,
    audioDuration: draft.audioDuration,
    uploadStatus: 'pending',
    uploadProgress: 0,
    uploadError: null,
    serverRecordingId: null,
    draftSlotId: draft.slotId,
    serverDraftId: draft.serverDraftId,
  }
  dispatch({ type: 'RESTORE_SESSION', slots: [restoredSlot] })
}
```

**D. Pending-sync banner:** Read `draftStorage.listDrafts()` in a `useEffect`; show a small informational banner if any have `pendingSync: true`. Wire `syncPending()` to a `NetInfo` `addEventListener('connectionChange')` handler (same package as `isConnected` above).

### Step 8 — `src/components/RecordingCard.tsx`
1. Add `localDraftSlotId?: string` prop.
2. In the status badge map, add `draft: { label: 'Not Submitted', color: amber }`.
3. Override `onPress` when `recording.status === 'draft'`:
   ```typescript
   if (recording.status === 'draft' && localDraftSlotId) {
     router.push(`/(tabs)/record?draftSlotId=${localDraftSlotId}`)
   } else {
     router.push(`/recordings/${recording.id}`)
   }
   ```

### Step 9 — Home screen & Recordings list
Both screens follow the same pattern:

```typescript
// On mount / when user changes / after any recording query invalidation:
const [draftMap, setDraftMap] = useState<Record<string, string>>({}) // serverDraftId → draftSlotId

const refreshDraftMap = useCallback(() => {
  draftStorage.listDrafts().then(drafts => {
    const map: Record<string, string> = {}
    for (const d of drafts) {
      if (d.serverDraftId) map[d.serverDraftId] = d.slotId
    }
    setDraftMap(map)
  }).catch(() => {})
}, [user?.id])

useEffect(() => { refreshDraftMap() }, [refreshDraftMap])

// Also refresh after submit clears a draft — call refreshDraftMap() alongside
// queryClient.invalidateQueries({ queryKey: ['recordings'] }) in record.tsx's uploadSlot,
// or trigger via AppState 'active' listener (already used elsewhere in the app).

// When rendering RecordingCard:
<RecordingCard
  recording={recording}
  localDraftSlotId={draftMap[recording.id]}
/>
```

---

## Error Handling Summary

| Scenario | Behaviour |
|----------|-----------|
| `draftStorage.saveDraft()` fails (storage full) | Caught silently; user can still submit this session |
| Server draft create fails (network error) | `pendingSync: true`; retried on reconnect; upload falls back to fresh `create()` |
| Submit with `serverDraftId: null` (offline, never synced) | `uploadSlot()` falls back to existing `createWithFile()` which calls `create()` internally |
| Tap "Not Submitted" card with active unsaved session | Alert: confirm before overwriting current session |
| Tap "Not Submitted" card, audio missing | Alert: offer to re-record with pre-filled form; server draft + local draft deleted |
| Sign-out | `draftStorage.clearAll()` in PHI cleanup Promise.all |

---

## Verification

1. **Happy path (online):** Record a patient → tap Finish → immediately check Recent Recordings on home screen → "Not Submitted" badge appears → close app → reopen → card still there → tap card → record screen loads with patient pre-filled + audio ready → tap Submit → recording transitions to processing → "Not Submitted" card disappears.

2. **Offline path:** Disable Wi-Fi → record → tap Finish → confirm pending-sync banner appears → re-enable Wi-Fi → banner disappears → "Not Submitted" card appears in listings.

3. **Multi-patient:** 2-patient session → finish Patient A → close app → reopen → one "Not Submitted" card in listings → tap → record screen shows Patient A ready to submit.

4. **Missing audio:** Tap "Not Submitted" card after clearing app data → Alert fires with re-record option → form pre-fills with original patient details.

5. **Active session guard:** Have recording in progress → navigate to recordings list → tap a "Not Submitted" card → confirm alert fires before session is replaced.

6. **Sign-out cleanup:** Sign out → sign in as different user → no draft cards from previous user appear.

7. **PHI audit:** Confirm no draft audio files remain in `documentDirectory/drafts/` after successful submit and after sign-out.
