# Missing Mobile Functionality — Updated Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan phase-by-phase. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring VetSOAP-Mobile to full feature parity with the existing server and Expo reference client, covering patient directory, SOAP editing/export/regeneration, auth recovery, and follow-up clinical tools.

**Architecture:** Each phase is a self-contained delivery unit. Phases 0–3 establish shared infrastructure (API layer, permissions hook, list filtering) that later phases depend on; they must land in order. Phases 4–9 are largely independent after Phase 0–3 complete.

**Tech Stack:** Expo SDK 55, React Native 0.83.4, React 19, expo-router (file-based), React Query (`@tanstack/react-query`), NativeWind v4 (Tailwind via `global.css`), Supabase Auth, TypeScript strict mode, Hermes JS engine (Android production).

---

## Changes from the Previous Plan (2026-04-11)

This document supersedes `docs/missing-mobile-functionality-implementation-plan-2026-04-11.md`. Key changes:

1. **Phases are numbered in delivery order.** The previous plan numbered phases thematically (Phase 1 = patients, Phase 6 = list refinement) but recommended a different delivery order. This caused tracking confusion. Phases here are numbered 1–9 in the order they should ship.
2. **Phase 0 added.** Three cross-cutting infrastructure pieces — `soapNotesApi` module, `usePermissions` hook, and deep-link URL handler — were missing from the previous plan but are required by Phases 4, 5, and 6 respectively.
3. **`soapNotesApi` creation is an explicit task.** The previous plan referenced `soapNotesApi.update()` and `soapNotesApi.export()` as if the module existed. It doesn't — it must be created.
4. **`usePermissions(recording)` hook added.** The previous plan mentioned role-based access as per-phase checkboxes without a shared design. Threading permission checks into 4+ screens without a shared hook leads to duplicated logic. The hook is defined once in Phase 0.
5. **Deep link handler for password reset is an explicit task.** `captivet://reset-password` needs a URL handler in `app/_layout.tsx` to intercept the Supabase email redirect. The previous plan omitted this.
6. **Phase 8 template selection improvement is clarified.** "Improve recording-time template selection" is now a concrete task: add a template preview sheet to `PatientSlotCard` that shows description and section types before confirming.
7. **Scope check on `SoapNote` type.** Verify server `PATCH /api/soap-notes/:id` response shape against mobile `SoapNote` type before starting Phase 4.
8. **`Patient._count.recordings` note.** The mobile `Patient` type doesn't include `_count`. Verify whether `GET /api/patients` list items include it before displaying visit count in Phase 1.

---

## Scope Check

Each phase is independently deployable. However, **Phase 0 must ship before Phases 4, 5, and 6** because they depend on `soapNotesApi` and `usePermissions`. If implementing phases in parallel, assign Phase 0 first.

When handing a phase to an implementer, extract its section as a standalone plan doc and run `superpowers:executing-plans` against it.

---

## File Structure

All new files and all existing files that will be modified.

### New Files

| File | Responsibility |
|---|---|
| `src/api/soapNotes.ts` | API calls for SOAP note update, export, and fetch-by-id |
| `src/hooks/usePermissions.ts` | Derive edit/delete/export permission booleans from `User` + `Recording` |
| `app/(app)/(tabs)/patient/index.tsx` | Patient list/search screen |
| `app/(auth)/forgot-password.tsx` | Email input → Supabase `resetPasswordForEmail` |
| `app/(auth)/reset-password.tsx` | New password form gated on recovery session state |

### Modified Files

| File | What changes |
|---|---|
| `src/api/patients.ts` | Add `list(params)` method |
| `src/api/recordings.ts` | Add `completeMetadata()`, `translate()`, `generateEmailDraft()` |
| `src/api/templates.ts` | Add `get(id)`, add species/appointmentType filter params |
| `src/types/index.ts` | Add `ListPatientsParams`; verify/add `SoapNote.additionalNotes` if server supports it; add `_count` to patient list response type if server returns it |
| `app/(app)/(tabs)/_layout.tsx` | Add visible Patients tab |
| `app/(app)/(tabs)/recordings/index.tsx` | Add status filter strip |
| `app/(app)/(tabs)/recordings/[id].tsx` | Add transcript, edit/export/regenerate actions, delete, cost display, pending-metadata completion link |
| `app/(auth)/login.tsx` | Add "Forgot password?" link |
| `app/_layout.tsx` | Add deep-link URL handler for `captivet://reset-password` |
| `src/components/SoapNoteView.tsx` | Add `editable`, `onSave`, `onExport`, `onRegenerate` props; section edit mode |
| `src/components/PatientSlotCard.tsx` | Add template preview sheet |

---

## Phase 0: Cross-Cutting Infrastructure

These three items are prerequisites for Phases 4, 5, and 6. They have no UI of their own. Ship together.

### 0A — Create `src/api/soapNotes.ts`

**Files:**
- Create: `src/api/soapNotes.ts`

The previous plan referenced `soapNotesApi.update()` and `soapNotesApi.export()` throughout. The module must be created before any Phase 4 work begins. SOAP note fetching currently lives in `recordingsApi.getSoapNote()` — keep that call as-is (it's used by the detail screen already). This module only handles mutations.

- [ ] Create `src/api/soapNotes.ts`:

```typescript
import { apiClient } from './client';
import type { SoapNote } from '../types';

export type SoapNoteSection = 'subjective' | 'objective' | 'assessment' | 'plan';

export interface UpdateSoapNotePayload {
  subjective?: string;
  objective?: string;
  assessment?: string;
  plan?: string;
}

export type ExportTarget =
  | 'clipboard'
  | 'manual'
  | 'pdf'
  | 'ezyvet'
  | 'vetmatrix'
  | 'cornerstone'
  | 'avimark'
  | 'impromed';

export interface ExportSoapNotePayload {
  exportedTo: ExportTarget;
}

export const soapNotesApi = {
  async update(id: string, payload: UpdateSoapNotePayload): Promise<SoapNote> {
    return apiClient.request(`/api/soap-notes/${id}`, {
      method: 'PATCH',
      body: payload,
    });
  },

  async export(id: string, payload: ExportSoapNotePayload): Promise<SoapNote> {
    return apiClient.request(`/api/soap-notes/${id}/export`, {
      method: 'POST',
      body: payload,
    });
  },
};
```

- [ ] Run `npx tsc --noEmit` and fix any type errors before continuing.

- [ ] Commit: `feat(api): add soapNotesApi with update and export`

---

### 0B — Create `src/hooks/usePermissions.ts`

**Files:**
- Create: `src/hooks/usePermissions.ts`

The previous plan mentioned role-based access (support staff can't edit, owner/admin can) as per-phase checkboxes. Without a shared hook this logic gets duplicated across 4+ screens. Define it once here.

Permission rules (mirror server):
- `canEdit`: `role === 'owner' || role === 'admin' || recording.userId === currentUser.id`
- `canDelete`: same as `canEdit`
- `canExport`: all roles
- `canCopy`: all roles
- `canRetry`: `role === 'owner' || role === 'admin' || recording.userId === currentUser.id`

- [ ] Create `src/hooks/usePermissions.ts`:

```typescript
import { useContext } from 'react';
import { AuthContext } from '../auth/AuthProvider';
import type { Recording } from '../types';

export interface RecordingPermissions {
  canEdit: boolean;
  canDelete: boolean;
  canExport: boolean;
  canCopy: boolean;
  canRetry: boolean;
}

export function useRecordingPermissions(recording: Recording | null | undefined): RecordingPermissions {
  const { user } = useContext(AuthContext);

  if (!user || !recording) {
    return { canEdit: false, canDelete: false, canExport: false, canCopy: false, canRetry: false };
  }

  const isAuthor = recording.userId === user.id;
  const isPrivileged = user.role === 'owner' || user.role === 'admin';
  const canModify = isAuthor || isPrivileged;

  return {
    canEdit: canModify,
    canDelete: canModify,
    canRetry: canModify,
    canExport: true,
    canCopy: true,
  };
}
```

> **Note:** Verify that `AuthContext` exports `user` directly. In `src/auth/AuthProvider.tsx`, the context value includes `user: User | null`. If the export name differs, update the import.

- [ ] Confirm `AuthContext` is exported from `src/auth/AuthProvider.tsx` and exposes `user`. If it uses a different pattern (e.g., `useAuth()` hook only), update `usePermissions` to call `useAuth()` instead.

- [ ] Run `npx tsc --noEmit` and fix any errors.

- [ ] Commit: `feat(hooks): add useRecordingPermissions hook`

---

### 0C — Verify `SoapNote` type against server response

**Files:**
- Possibly modify: `src/types/index.ts`

The mobile `SoapNote` type (`src/types/index.ts:105–120`) has four sections and export metadata. The server `PATCH /api/soap-notes/:id` may accept `additionalNotes`. Confirm before Phase 4 begins.

- [ ] In the server codebase, read `VetSOAP-Connect/apps/api/src/routes/soap-notes.ts` lines 45–118 and check whether the response includes fields not present in the mobile `SoapNote` type (`src/types/index.ts:105–120`).

- [ ] If the server returns `additionalNotes: string | null`, add it to `SoapNote` in `src/types/index.ts` and add `additionalNotes?: string` to `UpdateSoapNotePayload` in `src/api/soapNotes.ts`.

- [ ] Run `npx tsc --noEmit` to verify no type regressions.

- [ ] Commit only if types changed: `fix(types): align SoapNote with server response shape`

---

## Phase 1: Patient Directory

**Delivery slot:** 1 of 9 (was "Phase 1" in previous plan)

### Outcome

Users can browse and search patients directly from mobile navigation without first going through a recording.

### Server truth

- `GET /api/patients` — confirmed. Supports `page`, `limit`, `search` (matches `name` and `pimsPatientId`).
- `GET /api/patients/:id` — confirmed. Already used by existing `patient/[id].tsx`.
- `GET /api/patients/:id/recordings` — confirmed. Already used in the patient detail screen.
- Patient list response: verify whether items include `_count.recordings` before displaying visit count. If not, omit the count — don't show `undefined`.

### Tasks

**1.1 — Add `patientsApi.list()`**

Files: Modify `src/api/patients.ts`

- [ ] Add `ListPatientsParams` interface and `list()` method to `src/types/index.ts` and `src/api/patients.ts`:

In `src/types/index.ts`, after the `Patient` interface:
```typescript
export interface ListPatientsParams {
  page?: number;
  limit?: number;
  search?: string;
}
```

In `src/api/patients.ts`, inside `patientsApi`:
```typescript
async list(params: ListPatientsParams = {}): Promise<PaginatedResponse<Patient>> {
  const query: Record<string, string | number | undefined> = {};
  if (params.page !== undefined) query.page = params.page;
  if (params.limit !== undefined) query.limit = params.limit;
  if (params.search) query.search = params.search;
  return apiClient.get('/api/patients', query);
},
```

- [ ] In the emulator or against the real API, confirm whether the response items include `_count: { recordings: number }`. If yes, add to the `Patient` type:
```typescript
_count?: { recordings: number };
```

- [ ] Run `npx tsc --noEmit`.

- [ ] Commit: `feat(api): add patientsApi.list with search and pagination`

---

**1.2 — Add patient list screen**

Files: Create `app/(app)/(tabs)/patient/index.tsx`

Pattern: mirror `app/(app)/(tabs)/recordings/index.tsx` — infinite query, debounced search, pull-to-refresh, skeleton loading, empty/error states.

- [ ] Create `app/(app)/(tabs)/patient/index.tsx`:

```tsx
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { View, Text, TextInput, FlatList, RefreshControl, Pressable, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import Animated, { FadeInRight } from 'react-native-reanimated';
import { Search, User } from 'lucide-react-native';
import { patientsApi } from '../../../../src/api/patients';
import { useResponsive } from '../../../../src/hooks/useResponsive';
import { CONTENT_MAX_WIDTH } from '../../../../src/components/ui/ScreenContainer';
import { SkeletonCard } from '../../../../src/components/ui/Skeleton';
import { Button } from '../../../../src/components/ui/Button';
import type { Patient } from '../../../../src/types';

const PAGE_SIZE = 20;
const CONTENT_STYLE = { paddingHorizontal: 20, paddingBottom: 20 } as const;

function PatientRow({ patient }: { patient: Patient }) {
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.push(`/patient/${patient.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`View patient ${patient.name}`}
      className="bg-white border border-stone-200 rounded-input p-4 mb-2 active:bg-stone-50"
    >
      <Text className="text-body font-semibold text-stone-900">{patient.name}</Text>
      <View className="flex-row flex-wrap gap-x-4 mt-1">
        {patient.pimsPatientId ? (
          <Text className="text-caption text-stone-400">ID: {patient.pimsPatientId}</Text>
        ) : null}
        {patient.species ? (
          <Text className="text-caption text-stone-400">{patient.species}</Text>
        ) : null}
        {patient.breed ? (
          <Text className="text-caption text-stone-400">{patient.breed}</Text>
        ) : null}
        {patient._count?.recordings !== undefined ? (
          <Text className="text-caption text-stone-400">
            {patient._count.recordings} visit{patient._count.recordings !== 1 ? 's' : ''}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export default function PatientListScreen() {
  const { iconSm, iconLg } = useResponsive();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const isInitialMountRef = useRef(true);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading, isError, refetch, isRefetching, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ['patients', 'list', debouncedSearch],
      queryFn: ({ pageParam = 1 }) =>
        patientsApi.list({ search: debouncedSearch || undefined, page: pageParam, limit: PAGE_SIZE }),
      initialPageParam: 1,
      getNextPageParam: (lastPage) => {
        if (!lastPage.pagination) return undefined;
        const { page, totalPages } = lastPage.pagination;
        return page < totalPages ? page + 1 : undefined;
      },
    });

  const patients = useMemo(() => data?.pages.flatMap((p) => p.data) ?? [], [data]);
  const keyExtractor = useCallback((item: Patient) => item.id, []);

  useEffect(() => {
    if (data && isInitialMountRef.current) isInitialMountRef.current = false;
  }, [data]);

  return (
    <SafeAreaView className="screen items-center">
      <View style={{ flex: 1, width: '100%', maxWidth: CONTENT_MAX_WIDTH }}>
        <View className="px-5 pt-5 pb-0">
          <Text className="text-display font-bold text-stone-900 mb-4" accessibilityRole="header">
            Patients
          </Text>
          <View
            className={`flex-row items-center bg-white border rounded-input px-3 mb-4 ${
              isFocused ? 'border-brand-500' : 'border-stone-300'
            }`}
          >
            <Search color="#78716c" size={iconSm} />
            <TextInput
              value={search}
              onChangeText={setSearch}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder="Search by name or PIMS ID..."
              placeholderTextColor="#78716c"
              accessibilityLabel="Search patients"
              className="flex-1 p-3 text-body text-stone-900"
            />
          </View>
        </View>

        <FlatList
          data={patients}
          keyExtractor={keyExtractor}
          renderItem={({ item, index }) =>
            isInitialMountRef.current && index < 3 ? (
              <Animated.View entering={FadeInRight.delay(index * 50).duration(250)}>
                <PatientRow patient={item} />
              </Animated.View>
            ) : (
              <PatientRow patient={item} />
            )
          }
          contentContainerStyle={CONTENT_STYLE}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={() => { refetch().catch(() => {}); }} />
          }
          onEndReached={() => { if (hasNextPage && !isFetchingNextPage) fetchNextPage().catch(() => {}); }}
          onEndReachedThreshold={0.8}
          removeClippedSubviews
          maxToRenderPerBatch={5}
          windowSize={7}
          initialNumToRender={8}
          ListFooterComponent={
            isFetchingNextPage ? (
              <View className="py-4 items-center">
                <ActivityIndicator size="small" color="#0d8775" />
              </View>
            ) : null
          }
          ListEmptyComponent={
            isLoading ? (
              <View><SkeletonCard /><SkeletonCard /><SkeletonCard /></View>
            ) : isError ? (
              <View className="py-10 items-center">
                <User color="#dc2626" size={iconLg} />
                <Text className="text-body text-stone-600 mt-3 text-center">Could not load patients.</Text>
                <View className="mt-4">
                  <Button variant="secondary" size="sm" onPress={() => { refetch().catch(() => {}); }}>Retry</Button>
                </View>
              </View>
            ) : (
              <View className="py-10 items-center">
                <User color="#78716c" size={iconLg} />
                <Text className="text-body text-stone-500 mt-3 text-center">
                  {search ? 'No patients match your search.' : 'No patients yet.'}
                </Text>
              </View>
            )
          }
        />
      </View>
    </SafeAreaView>
  );
}
```

- [ ] Run `npx tsc --noEmit`.

---

**1.3 — Add Patients tab to navigation**

Files: Modify `app/(app)/(tabs)/_layout.tsx`

- [ ] Add `Users` to the lucide import and add the Patients tab screen. The tab bar currently has Home, Record, Records. Add Patients between Records and the hidden screens:

In `app/(app)/(tabs)/_layout.tsx`:
```tsx
// Add to imports:
import { Home, Mic, FileText, Users } from 'lucide-react-native';

// Add after the Records Tabs.Screen, before the hidden screens:
<Tabs.Screen
  name="patient"
  options={{
    title: 'Patients',
    tabBarIcon: ({ color, size }) => <Users color={color} size={size} />,
    tabBarAccessibilityLabel: 'Browse patients',
  }}
/>
```

> **Note:** Removing `href: null` from the `patient` entry is sufficient to make it appear. The `patient/index.tsx` created in Task 1.2 becomes the default screen for that tab. The existing `patient/[id].tsx` is still navigable as a nested route.

- [ ] Run `npx tsc --noEmit`.

- [ ] Start Metro (`npx expo start --clear`), open emulator, verify four tabs appear and Patients tab loads the list screen.

- [ ] Commit: `feat(patients): add patient list screen and Patients tab`

---

## Phase 2: Recordings List Refinement

**Delivery slot:** 2 of 9 (was "Phase 6" in previous plan)

Doing this before imported-recordings (Phase 3) because the filter for `pending_metadata` falls out naturally from the status filter strip, and Phase 3's "recordings filter for imports" task requires it.

### Outcome

Users can find important recordings quickly by status: All, Processing, Completed, Failed, Awaiting Details.

### Server truth

- `GET /api/recordings` — confirmed. Supports `status`, `search`, `userId`, `page`, `limit`, `sortBy`, `sortOrder`.
- `pending_metadata` is a valid `status` filter value.

### Tasks

**2.1 — Add status filter strip to recordings list**

Files: Modify `app/(app)/(tabs)/recordings/index.tsx`

- [ ] Add a `selectedStatus` state and a horizontally scrollable filter strip above the search bar. Update the `useInfiniteQuery` `queryKey` and `queryFn` to include `selectedStatus`.

Add these types and constants near the top of the file (after imports):
```tsx
type StatusFilter = 'all' | 'processing' | 'completed' | 'failed' | 'pending_metadata';

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'processing', label: 'Processing' },
  { key: 'completed', label: 'Completed' },
  { key: 'failed', label: 'Failed' },
  { key: 'pending_metadata', label: 'Awaiting Details' },
];

// "processing" maps to the set of non-terminal, non-metadata statuses
const PROCESSING_STATUSES = ['uploading', 'uploaded', 'transcribing', 'transcribed', 'generating'];
```

Add `selectedStatus` state:
```tsx
const [selectedStatus, setSelectedStatus] = useState<StatusFilter>('all');
```

Replace the `useInfiniteQuery` call's `queryKey` and `queryFn`:
```tsx
queryKey: ['recordings', 'list', debouncedSearch, selectedStatus],
queryFn: ({ pageParam = 1 }) => {
  const statusParam: string | undefined =
    selectedStatus === 'all'
      ? undefined
      : selectedStatus === 'processing'
        ? undefined  // server doesn't support multi-value status; fetch all and rely on polling
        : selectedStatus;
  return recordingsApi.list({
    search: debouncedSearch || undefined,
    status: statusParam,
    page: pageParam,
    limit: PAGE_SIZE,
    sortBy: 'createdAt',
    sortOrder: 'desc',
  });
},
```

> **Note on "Processing" filter:** The server `status` param accepts a single value. The "processing" filter here sends no status param and instead relies on the client filtering. For v1 this is acceptable. If the server later supports multi-value status, update `statusParam` to a comma-separated string.

Add the filter strip JSX between the page title and the search bar:
```tsx
<ScrollView
  horizontal
  showsHorizontalScrollIndicator={false}
  className="mb-3 -mx-5 px-5"
  contentContainerStyle={{ gap: 8 }}
>
  {STATUS_FILTERS.map((f) => (
    <Pressable
      key={f.key}
      onPress={() => {
        setSelectedStatus(f.key);
        Haptics.selectionAsync().catch(() => {});
      }}
      accessibilityRole="button"
      accessibilityState={{ selected: selectedStatus === f.key }}
      accessibilityLabel={`Filter by ${f.label}`}
      className={`px-4 py-2 rounded-full border ${
        selectedStatus === f.key
          ? 'bg-brand-500 border-brand-500'
          : 'bg-white border-stone-300'
      }`}
    >
      <Text
        className={`text-body-sm font-medium ${
          selectedStatus === f.key ? 'text-white' : 'text-stone-700'
        }`}
      >
        {f.label}
      </Text>
    </Pressable>
  ))}
</ScrollView>
```

Add `ScrollView` and `Pressable` to the React Native import. Add `* as Haptics from 'expo-haptics'`.

- [ ] Reset filter to `'all'` when navigating back to the list from recording detail (this is automatic because the screen stays mounted — no explicit reset needed unless you add a `useFocusEffect`). Verify by filtering to "Failed," navigating into a detail, backing out, and confirming filter is preserved. Preservation is correct behavior.

- [ ] Run `npx tsc --noEmit`.

- [ ] Test on emulator: each filter chip changes the list. "Awaiting Details" shows only `pending_metadata` recordings (if any exist in the test account).

- [ ] Commit: `feat(recordings): add status filter strip to recordings list`

---

## Phase 3: Imported Recordings / Pending Metadata

**Delivery slot:** 3 of 9 (was "Phase 2" in previous plan)

### Outcome

Imported recordings in `pending_metadata` are actionable on mobile. Users can complete patient/template details and kick off processing without leaving the app.

### Server truth

- `PATCH /api/recordings/:id/complete-metadata` — confirmed. Accepts: `patientName`, `clientName`, `species`, `breed`, `appointmentType`, `templateId`, `foreignLanguage`. Transitions recording to processing state on success.

### Tasks

**3.1 — Add `recordingsApi.completeMetadata()`**

Files: Modify `src/api/recordings.ts`

- [ ] Add the interface and method. In `src/api/recordings.ts`, after the existing `ListRecordingsParams` interface:

```typescript
export interface CompleteMetadataPayload {
  patientName?: string;
  clientName?: string;
  species?: string;
  breed?: string;
  appointmentType?: string;
  templateId?: string | null;
  foreignLanguage?: boolean;
}
```

Inside `recordingsApi`:
```typescript
async completeMetadata(id: string, payload: CompleteMetadataPayload): Promise<Recording> {
  return apiClient.request(`/api/recordings/${id}/complete-metadata`, {
    method: 'PATCH',
    body: payload,
  });
},
```

- [ ] Run `npx tsc --noEmit`.

- [ ] Commit: `feat(api): add recordingsApi.completeMetadata`

---

**3.2 — Replace the static pending-metadata card with an actionable form**

Files: Modify `app/(app)/(tabs)/recordings/[id].tsx`

Currently, `pending_metadata` shows a static warning card (lines 346–360) saying "Complete the details on the web app." Replace it with a form backed by `completeMetadata`.

- [ ] Add the `useTemplates` hook and `useMutation` imports to the detail screen:

```tsx
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTemplates } from '../../../../src/hooks/useTemplates';
import { recordingsApi, type CompleteMetadataPayload } from '../../../../src/api/recordings';
```

- [ ] Add a `MetadataForm` component inside `[id].tsx` (above the main screen component). This component is only used in this file, so no reason to extract it:

```tsx
function MetadataForm({
  recording,
  onSuccess,
}: {
  recording: Recording;
  onSuccess: () => void;
}) {
  const queryClient = useQueryClient();
  const { templates } = useTemplates();
  const [patientName, setPatientName] = useState(recording.patientName ?? '');
  const [clientName, setClientName] = useState(recording.clientName ?? '');
  const [species, setSpecies] = useState(recording.species ?? '');
  const [breed, setBreed] = useState(recording.breed ?? '');
  const [appointmentType, setAppointmentType] = useState(recording.appointmentType ?? '');
  const [templateId, setTemplateId] = useState<string | null>(recording.templateId ?? null);
  const [foreignLanguage, setForeignLanguage] = useState(recording.foreignLanguage ?? false);

  const mutation = useMutation({
    mutationFn: (payload: CompleteMetadataPayload) =>
      recordingsApi.completeMetadata(recording.id, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recording', recording.id] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ['recordings', 'list'] }).catch(() => {});
      onSuccess();
    },
    onError: (error: Error) => {
      Alert.alert('Error', error instanceof ApiError ? error.message : 'Could not save details. Please try again.');
    },
  });

  const handleSubmit = () => {
    if (!patientName.trim()) {
      Alert.alert('Required', 'Patient name is required.');
      return;
    }
    mutation.mutate({ patientName, clientName, species, breed, appointmentType, templateId, foreignLanguage });
  };

  return (
    <Card className="mx-5 mb-4 border-warning-200">
      <Text className="text-body-lg font-semibold text-stone-900 mb-1">Complete Patient Details</Text>
      <Text className="text-body-sm text-stone-500 mb-4">
        This recording was imported and needs details before processing can begin.
      </Text>
      <TextInputField label="Patient Name" value={patientName} onChangeText={setPatientName} placeholder="e.g. Buddy" />
      <TextInputField label="Client Name" value={clientName} onChangeText={setClientName} placeholder="e.g. Jane Smith" />
      <TextInputField label="Species" value={species} onChangeText={setSpecies} placeholder="e.g. Canine" />
      <TextInputField label="Breed" value={breed} onChangeText={setBreed} placeholder="e.g. Labrador" />
      <TextInputField label="Appointment Type" value={appointmentType} onChangeText={setAppointmentType} placeholder="e.g. Wellness Exam" />
      {templates.length > 0 && (
        <View className="mb-3">
          <Text className="text-caption text-stone-500 font-medium uppercase mb-1">Template</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <Pressable
              onPress={() => setTemplateId(null)}
              className={`mr-2 px-3 py-1.5 rounded-full border ${
                templateId === null ? 'bg-brand-500 border-brand-500' : 'bg-white border-stone-300'
              }`}
            >
              <Text className={`text-body-sm ${templateId === null ? 'text-white' : 'text-stone-700'}`}>
                Default
              </Text>
            </Pressable>
            {templates.map((t) => (
              <Pressable
                key={t.id}
                onPress={() => setTemplateId(t.id)}
                className={`mr-2 px-3 py-1.5 rounded-full border ${
                  templateId === t.id ? 'bg-brand-500 border-brand-500' : 'bg-white border-stone-300'
                }`}
              >
                <Text className={`text-body-sm ${templateId === t.id ? 'text-white' : 'text-stone-700'}`}>
                  {t.name}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}
      <View className="flex-row items-center justify-between mb-4">
        <Text className="text-body text-stone-700">Foreign Language Recording</Text>
        <Switch
          value={foreignLanguage}
          onValueChange={(v) => { setForeignLanguage(v); }}
          trackColor={{ true: '#0d8775' }}
        />
      </View>
      <Button variant="primary" onPress={handleSubmit} loading={mutation.isPending}>
        Start Processing
      </Button>
    </Card>
  );
}
```

Add `Switch` to the React Native import. Add `ScrollView` if not already imported.

- [ ] Replace the existing `pending_metadata` card (currently lines 346–360 of `[id].tsx`) with:

```tsx
{recording.status === 'pending_metadata' && (
  <MetadataForm recording={recording} onSuccess={() => { refetchRecording().catch(() => {}); }} />
)}
```

- [ ] Run `npx tsc --noEmit`.

- [ ] Test on emulator with a `pending_metadata` recording: form appears, can fill fields, submitting transitions the recording to processing and starts polling.

- [ ] Commit: `feat(recordings): add metadata completion form for pending_metadata recordings`

---

## Phase 4: Record Finalization

**Delivery slot:** 4 of 9 (was "Phase 3" in previous plan)

**Prerequisite:** Phase 0 (specifically `soapNotesApi` and `usePermissions`).

### Outcome

Completed recordings are reviewable, editable, exportable, and regeneratable on mobile using existing server APIs.

### Server truth

- `PATCH /api/soap-notes/:id` — confirmed. Updates section text; marks `isEdited: true`.
- `POST /api/soap-notes/:id/export` — confirmed. Accepts `exportedTo`. v1 mobile targets: `clipboard`, `manual`.
- `POST /api/recordings/:id/regenerate-soap` — confirmed. Accepts optional `templateId` and `section`.
- `GET /api/recordings/:id` — already returns `transcriptText`, `isExported`, `exportedAt`, `exportedTo`, `exportedBy`, `costBreakdown`.

### Tasks

**4.1 — Surface transcript and export status in recording detail**

Files: Modify `app/(app)/(tabs)/recordings/[id].tsx`

These are pure display additions — no mutations needed.

- [ ] After the `soapNote` query block (around line 178), add a transcript section and export status section inside the `completed` status block. In the existing JSX where `recording.status === 'completed'`:

```tsx
{/* Transcript */}
{recording.transcriptText && (
  <View className="px-5 mb-4">
    <Text className="text-heading font-bold text-stone-900 mb-2" accessibilityRole="header">
      Transcript
    </Text>
    <Card>
      <Text className="text-body-sm text-stone-600 leading-relaxed">
        {recording.transcriptText}
      </Text>
    </Card>
  </View>
)}

{/* Export status */}
{recording.isExported && (
  <View className="px-5 mb-4">
    <Card className="border-brand-100 bg-brand-50">
      <Text className="text-body-sm text-brand-700 font-medium">
        Exported{recording.exportedTo ? ` to ${recording.exportedTo}` : ''}
        {recording.exportedBy ? ` by ${recording.exportedBy.fullName}` : ''}
        {recording.exportedAt
          ? ` on ${new Date(recording.exportedAt).toLocaleDateString()}`
          : ''}
      </Text>
    </Card>
  </View>
)}

{/* Cost breakdown */}
{recording.costBreakdown && (
  <View className="px-5 mb-4">
    <Card>
      <Text className="text-caption text-stone-400 font-medium uppercase mb-1">Processing Cost</Text>
      <Text className="text-body-sm text-stone-600">
        ${((recording.costBreakdown.totalCostCents ?? 0) / 100).toFixed(4)}
      </Text>
    </Card>
  </View>
)}
```

- [ ] Run `npx tsc --noEmit`.

- [ ] Commit: `feat(recordings): surface transcript, export status, and cost breakdown`

---

**4.2 — Add edit mode to `SoapNoteView`**

Files: Modify `src/components/SoapNoteView.tsx`

`SoapNoteView` is accordion-based with per-section copy. Add an `editable` prop. When `editable` is true, tapping a section's expand header shows a `TextInput` instead of a `Text` view, with a "Save" button that calls `onSave(sectionKey, newContent)`.

- [ ] Extend the `SoapNoteViewProps` interface:

```typescript
interface SoapNoteViewProps {
  soapNote: SoapNote;
  editable?: boolean;
  isSaving?: boolean;
  onSave?: (section: 'subjective' | 'objective' | 'assessment' | 'plan', content: string) => void;
  onExport?: (target: 'clipboard' | 'manual') => void;
  onRegenerate?: (section?: 'subjective' | 'objective' | 'assessment' | 'plan') => void;
  isExporting?: boolean;
  isRegenerating?: boolean;
}
```

- [ ] In `AccordionSection`, add `editable`, `isSaving`, `onSave` props. When expanded and `editable` is true, render a `TextInput` pre-filled with the section content and a "Save" button below it:

```tsx
// Inside AccordionSection when isExpanded:
{isExpanded && (
  <Animated.View entering={FadeIn.duration(200)} className="p-3 pt-0 relative">
    {showCopied && <CopiedToast />}
    {editable ? (
      <>
        <TextInput
          value={editContent}
          onChangeText={setEditContent}
          multiline
          className="text-body text-stone-700 mt-2 leading-relaxed border border-stone-200 rounded-input p-2 min-h-[120px]"
          accessibilityLabel={`Edit ${label} section`}
          textAlignVertical="top"
        />
        <View className="flex-row justify-end gap-2 mt-2">
          <Button
            variant="ghost"
            size="sm"
            onPress={() => setEditContent(content)}
          >
            Reset
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={isSaving}
            onPress={() => onSave?.(sectionKey as 'subjective' | 'objective' | 'assessment' | 'plan', editContent)}
          >
            Save
          </Button>
        </View>
      </>
    ) : (
      <Text className="text-body text-stone-700 mt-2 leading-relaxed">{content ?? ''}</Text>
    )}
    <Pressable
      onPress={() => { copySection().catch(() => {}); }}
      accessibilityRole="button"
      accessibilityLabel={`Copy ${label} section`}
      className="self-end mt-2.5 flex-row items-center gap-1.5 px-3 py-1 rounded border border-stone-300 min-h-[44px]"
    >
      <Copy color="#57534e" size={12} />
      <Text className="text-caption text-stone-600" style={{ paddingRight: 4 }}>Copy</Text>
    </Pressable>
  </Animated.View>
)}
```

Add `editContent` state to `AccordionSection`: `const [editContent, setEditContent] = useState(content);`. Sync `editContent` when `content` prop changes via `useEffect`.

- [ ] In `SoapNoteView`, add Export and Regenerate buttons in the header area (next to "Copy All"), visible only when props are provided:

```tsx
<View className="flex-row gap-2 items-center">
  {onExport && (
    <Button
      variant="secondary"
      size="sm"
      loading={isExporting}
      onPress={() => onExport('manual')}
      accessibilityLabel="Mark as exported"
    >
      Export
    </Button>
  )}
  {onRegenerate && (
    <Button
      variant="secondary"
      size="sm"
      loading={isRegenerating}
      onPress={() => onRegenerate()}
      accessibilityLabel="Regenerate full SOAP note"
    >
      Regenerate
    </Button>
  )}
</View>
```

- [ ] Add `TextInput` to the React Native import in `SoapNoteView.tsx`.

- [ ] Run `npx tsc --noEmit`.

- [ ] Commit: `feat(components): add edit/export/regenerate mode to SoapNoteView`

---

**4.3 — Wire edit/export/regenerate mutations into recording detail**

Files: Modify `app/(app)/(tabs)/recordings/[id].tsx`

- [ ] Import `soapNotesApi` and `useRecordingPermissions` at the top of `[id].tsx`:

```tsx
import { soapNotesApi } from '../../../../src/api/soapNotes';
import { useRecordingPermissions } from '../../../../src/hooks/usePermissions';
import type { SoapNoteSection } from '../../../../src/api/soapNotes';
```

- [ ] Add three mutations in `RecordingDetailScreen` (after the existing `retryMutation`):

```tsx
const permissions = useRecordingPermissions(recording);

const editMutation = useMutation({
  mutationFn: ({ section, content }: { section: SoapNoteSection; content: string }) =>
    soapNotesApi.update(soapNote!.id, { [section]: content }),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['soapNote', id] }).catch(() => {});
  },
  onError: (error: Error) => {
    Alert.alert('Save Failed', error instanceof ApiError ? error.message : 'Could not save changes.');
  },
});

const exportMutation = useMutation({
  mutationFn: (target: 'clipboard' | 'manual') =>
    soapNotesApi.export(soapNote!.id, { exportedTo: target }),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['recording', id] }).catch(() => {});
    queryClient.invalidateQueries({ queryKey: ['soapNote', id] }).catch(() => {});
  },
  onError: (error: Error) => {
    Alert.alert('Export Failed', error instanceof ApiError ? error.message : 'Could not mark as exported.');
  },
});

const regenerateMutation = useMutation({
  mutationFn: (section?: SoapNoteSection) =>
    apiClient.request(`/api/recordings/${id}/regenerate-soap`, {
      method: 'POST',
      body: section ? { section } : {},
    }),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['recording', id] }).catch(() => {});
    queryClient.invalidateQueries({ queryKey: ['soapNote', id] }).catch(() => {});
  },
  onError: (error: Error) => {
    Alert.alert('Regenerate Failed', error instanceof ApiError ? error.message : 'Could not regenerate SOAP note.');
  },
});
```

> Regeneration uses `apiClient` directly since the endpoint is on recordings, not soap-notes. Add a `recordingsApi.regenerateSoap(id, payload)` method if preferred.

- [ ] Update the `SoapNoteView` render call to pass the new props:

```tsx
<SoapNoteView
  soapNote={soapNote}
  editable={permissions.canEdit}
  isSaving={editMutation.isPending}
  onSave={(section, content) => {
    Alert.alert(
      'Save Changes',
      'This will overwrite the current section content.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Save', onPress: () => editMutation.mutate({ section, content }) },
      ]
    );
  }}
  onExport={permissions.canExport ? (target) => exportMutation.mutate(target) : undefined}
  isExporting={exportMutation.isPending}
  onRegenerate={permissions.canEdit ? (section) => {
    Alert.alert(
      'Regenerate',
      section
        ? `Regenerate the ${section} section? This will overwrite your current content.`
        : 'Regenerate the full SOAP note? This will overwrite all sections.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Regenerate', onPress: () => regenerateMutation.mutate(section) },
      ]
    );
  } : undefined}
  isRegenerating={regenerateMutation.isPending}
/>
```

- [ ] Run `npx tsc --noEmit`.

- [ ] Test on emulator: edit a section, save, observe updated content on refresh. Export button marks the note exported. Regenerate shows confirmation alert.

- [ ] Commit: `feat(recordings): wire SOAP edit, export, and regenerate into recording detail`

---

## Phase 5: Recording Lifecycle Management

**Delivery slot:** 5 of 9 (was "Phase 5" in previous plan)

**Prerequisite:** Phase 0 (`usePermissions`).

### Outcome

Users can delete recordings with confirmation. The delete action respects server-side authorization.

### Server truth

- `DELETE /api/recordings/:id` — confirmed. Cascades to SoapNote. Deletes R2 audio (best-effort). Authorization: recording owner or owner/admin role.
- `recordingsApi.delete(id)` already exists in `src/api/recordings.ts`.

### Tasks

**5.1 — Add delete action to recording detail**

Files: Modify `app/(app)/(tabs)/recordings/[id].tsx`

- [ ] Add a delete mutation (after `regenerateMutation`):

```tsx
const deleteMutation = useMutation({
  mutationFn: () => recordingsApi.delete(id!),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['recordings', 'list'] }).catch(() => {});
    router.navigate('/recordings');
  },
  onError: (error: Error) => {
    Alert.alert('Delete Failed', error instanceof ApiError ? error.message : 'Could not delete recording.');
  },
});
```

- [ ] Add a delete button in the detail screen header area, visible only when `permissions.canDelete` is true. Place it in the header row (after `StatusBadge`):

```tsx
{permissions.canDelete && (
  <Pressable
    onPress={() => {
      Alert.alert(
        'Delete Recording',
        'This will permanently delete the recording and its SOAP note. This cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => deleteMutation.mutate(),
          },
        ]
      );
    }}
    accessibilityRole="button"
    accessibilityLabel="Delete recording"
    className="ml-2 w-11 h-11 items-center justify-center"
  >
    <Trash2 color="#dc2626" size={iconMd} />
  </Pressable>
)}
```

Add `Trash2` to the `lucide-react-native` import.

- [ ] Run `npx tsc --noEmit`.

- [ ] Test: delete button appears for the recording owner. Tapping shows confirmation. Confirming navigates back to the list and the recording is gone.

- [ ] Commit: `feat(recordings): add delete action with confirmation to recording detail`

---

## Phase 6: Auth Recovery Flows

**Delivery slot:** 6 of 9 (was "Phase 7" in previous plan)

### Outcome

Users can request password reset and complete password recovery entirely on mobile.

### Server/reference truth

- Reference screens confirmed in `VetSOAP-Connect/apps/expo/app/(auth)/forgot-password.tsx` and `reset-password.tsx`.
- Supabase mobile redirect: `captivet://reset-password` (confirmed in reference client).
- `captivet://` scheme is already registered in `app.config.ts`.

### Tasks

**6.1 — Add forgot-password screen**

Files: Create `app/(auth)/forgot-password.tsx`

- [ ] Create `app/(auth)/forgot-password.tsx`:

```tsx
import React, { useState } from 'react';
import { View, Text, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { supabase } from '../../src/auth/supabase';
import { Button } from '../../src/components/ui/Button';
import { TextInputField } from '../../src/components/ui/TextInputField';

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSend = async () => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) {
      Alert.alert('Email required', 'Please enter your email address.');
      return;
    }
    setIsLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(trimmed, {
        redirectTo: 'captivet://reset-password',
      });
      if (error) throw error;
      setSent(true);
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Could not send reset email.');
    } finally {
      setIsLoading(false);
    }
  };

  if (sent) {
    return (
      <SafeAreaView className="screen justify-center p-8">
        <Text className="text-display font-bold text-stone-900 mb-3 text-center">Check your email</Text>
        <Text className="text-body text-stone-500 text-center mb-6">
          We sent a reset link to {email.trim().toLowerCase()}. Tap the link in the email to set a new password.
        </Text>
        <Button variant="primary" onPress={() => router.back()}>Back to Login</Button>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="screen justify-center p-8">
      <Text className="text-display font-bold text-stone-900 mb-2">Reset password</Text>
      <Text className="text-body text-stone-500 mb-6">
        Enter the email address on your account and we'll send you a reset link.
      </Text>
      <TextInputField
        label="Email"
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
      />
      <Button variant="primary" onPress={() => { handleSend().catch(() => {}); }} loading={isLoading} className="mt-2">
        Send reset link
      </Button>
      <Button variant="ghost" onPress={() => router.back()} className="mt-2">
        Back to Login
      </Button>
    </SafeAreaView>
  );
}
```

> **Supabase import:** `supabase` is exported from `src/auth/supabase.ts`. Check that file exports the client directly (e.g., `export const supabase = createClient(...)`). If the export name differs, update the import.

- [ ] Run `npx tsc --noEmit`.

---

**6.2 — Add "Forgot password?" link to login screen**

Files: Modify `app/(auth)/login.tsx`

- [ ] Find the password input block in `login.tsx`. Add a "Forgot password?" link directly below or beside the password input:

```tsx
<Pressable
  onPress={() => router.push('/(auth)/forgot-password')}
  accessibilityRole="link"
  accessibilityLabel="Forgot password"
  className="self-end mb-4 min-h-[44px] justify-center"
>
  <Text className="text-body-sm text-brand-600">Forgot password?</Text>
</Pressable>
```

- [ ] Run `npx tsc --noEmit`.

---

**6.3 — Add deep-link URL handler in root layout**

Files: Modify `app/_layout.tsx`

This is the missing task from the previous plan. When a user taps the reset link in their email, iOS/Android opens `captivet://reset-password?...` with Supabase session tokens in the URL fragment or query. The root layout must intercept this, set the Supabase session, and route to the reset-password screen.

- [ ] In `app/_layout.tsx`, add a `useEffect` that listens for incoming URLs:

```tsx
import { useEffect } from 'react';
import * as Linking from 'expo-linking';
import { useRouter } from 'expo-router';
import { supabase } from '../src/auth/supabase';

// Inside the root layout component:
const router = useRouter();

useEffect(() => {
  const handleUrl = async (url: string) => {
    try {
      if (!url.includes('reset-password')) return;
      // Supabase appends tokens as a hash fragment: captivet://reset-password#access_token=...
      const parsed = Linking.parse(url);
      const fragment = parsed.path ?? '';
      const params = new URLSearchParams(fragment.includes('#') ? fragment.split('#')[1] : '');
      const accessToken = params.get('access_token') ?? (parsed.queryParams?.access_token as string | undefined);
      const refreshToken = params.get('refresh_token') ?? (parsed.queryParams?.refresh_token as string | undefined);
      if (accessToken && refreshToken) {
        const { error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
        if (!error) {
          router.push('/(auth)/reset-password');
        }
      }
    } catch (err) {
      if (__DEV__) console.error('[LinkHandler] reset-password URL error:', err);
    }
  };

  // Handle URL if app was already open
  Linking.getInitialURL().then((url) => {
    if (url) handleUrl(url).catch(() => {});
  }).catch(() => {});

  // Handle URL if app was opened from background by the link
  const sub = Linking.addEventListener('url', (event) => {
    handleUrl(event.url).catch(() => {});
  });

  return () => sub.remove();
}, [router]);
```

- [ ] Run `npx tsc --noEmit`.

---

**6.4 — Add reset-password screen**

Files: Create `app/(auth)/reset-password.tsx`

- [ ] Create `app/(auth)/reset-password.tsx`:

```tsx
import React, { useState } from 'react';
import { View, Text, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { supabase } from '../../src/auth/supabase';
import { Button } from '../../src/components/ui/Button';
import { TextInputField } from '../../src/components/ui/TextInputField';

export default function ResetPasswordScreen() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleReset = async () => {
    if (password.length < 8) {
      Alert.alert('Too short', 'Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      Alert.alert('Mismatch', 'Passwords do not match.');
      return;
    }
    setIsLoading(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setPassword('');
      setConfirm('');
      Alert.alert('Password updated', 'Your password has been changed. Please sign in.', [
        { text: 'OK', onPress: () => { supabase.auth.signOut().catch(() => {}); router.replace('/(auth)/login'); } },
      ]);
    } catch (err: unknown) {
      Alert.alert('Error', err instanceof Error ? err.message : 'Could not update password.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SafeAreaView className="screen justify-center p-8">
      <Text className="text-display font-bold text-stone-900 mb-2">Set new password</Text>
      <Text className="text-body text-stone-500 mb-6">Must be at least 8 characters.</Text>
      <TextInputField
        label="New password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        placeholder="••••••••"
        autoComplete="new-password"
      />
      <TextInputField
        label="Confirm password"
        value={confirm}
        onChangeText={setConfirm}
        secureTextEntry
        placeholder="••••••••"
        autoComplete="new-password"
      />
      <Button
        variant="primary"
        onPress={() => { handleReset().catch(() => {}); }}
        loading={isLoading}
        className="mt-2"
      >
        Update password
      </Button>
    </SafeAreaView>
  );
}
```

- [ ] Verify the `(auth)` layout in `app/(auth)/_layout.tsx` doesn't gate reset-password behind a session check that would block an unauthenticated deep-link entry. If it does, add `reset-password` to any public-route allowlist in that layout.

- [ ] Run `npx tsc --noEmit`.

- [ ] Test flow: trigger a password reset email for a test account, tap the link on device, confirm the app opens to the reset-password screen.

- [ ] Commit: `feat(auth): add forgot-password and reset-password flows with deep link handler`

---

## Phase 7: Template Visibility

**Delivery slot:** 7 of 9 (was "Phase 8" in previous plan)

### Outcome

Users can inspect a template's description, species filters, appointment-type filters, and section configuration before selecting it. Template selection during recording shows enough context to make an informed choice.

### Server truth

- `GET /api/templates/:id` — confirmed.
- `GET /api/templates` — confirmed. Supports `species`, `appointmentType`, `type` filters in addition to `isActive`.

### Tasks

**7.1 — Add `templatesApi.get()` and extended filtering**

Files: Modify `src/api/templates.ts`

- [ ] Replace the current `templatesApi` with:

```typescript
import { apiClient } from './client';
import type { Template, PaginatedResponse } from '../types';

export interface ListTemplatesParams {
  isActive?: boolean;
  species?: string;
  appointmentType?: string;
  type?: 'soap' | 'email' | 'dental' | 'ultrasound' | 'xray';
  page?: number;
  limit?: number;
}

export const templatesApi = {
  async list(params: ListTemplatesParams = {}): Promise<PaginatedResponse<Template>> {
    const query: Record<string, string | number | undefined> = { limit: 100 };
    if (params.isActive !== undefined) query.isActive = String(params.isActive);
    if (params.species) query.species = params.species;
    if (params.appointmentType) query.appointmentType = params.appointmentType;
    if (params.type) query.type = params.type;
    if (params.page !== undefined) query.page = params.page;
    if (params.limit !== undefined) query.limit = params.limit;
    return apiClient.get('/api/templates', query);
  },

  async get(id: string): Promise<Template> {
    return apiClient.get(`/api/templates/${id}`);
  },
};
```

- [ ] Run `npx tsc --noEmit`.

- [ ] Commit: `feat(api): extend templatesApi with get(id) and species/appointmentType filters`

---

**7.2 — Add template preview sheet to recording form**

Files: Modify `src/components/PatientSlotCard.tsx`

The recording form already has a template picker using `useTemplates`. "Improve recording-time template selection" means: when a user selects a template, show a bottom sheet with the template's name, description, active sections, species filter, and appointment-type filter before confirming. This gives clinical context without requiring a separate Template Browser screen in v1.

- [ ] Add a `selectedTemplateForPreview` state to `PatientSlotCard`. When a template chip/button is pressed, set it and show a `Modal`:

```tsx
const [templatePreview, setTemplatePreview] = useState<Template | null>(null);

// In the template picker, change onPress to show preview first:
onPress={() => setTemplatePreview(template)}

// Modal at bottom of PatientSlotCard JSX:
<Modal
  visible={templatePreview !== null}
  transparent
  animationType="slide"
  onRequestClose={() => setTemplatePreview(null)}
>
  <Pressable className="flex-1 bg-black/40" onPress={() => setTemplatePreview(null)} />
  <View className="bg-white rounded-t-2xl p-6 pb-10">
    <Text className="text-heading font-bold text-stone-900 mb-1">{templatePreview?.name}</Text>
    {templatePreview?.description ? (
      <Text className="text-body-sm text-stone-500 mb-3">{templatePreview.description}</Text>
    ) : null}
    <View className="flex-row flex-wrap gap-2 mb-4">
      {templatePreview?.species?.map((s) => (
        <View key={s} className="px-2 py-1 bg-stone-100 rounded"><Text className="text-caption text-stone-600">{s}</Text></View>
      ))}
      {templatePreview?.appointmentTypes?.map((a) => (
        <View key={a} className="px-2 py-1 bg-brand-50 rounded"><Text className="text-caption text-brand-700">{a}</Text></View>
      ))}
    </View>
    <View className="flex-row gap-3">
      <Button variant="ghost" onPress={() => setTemplatePreview(null)} style={{ flex: 1 }}>Cancel</Button>
      <Button
        variant="primary"
        onPress={() => {
          // dispatch template selection to session state
          onTemplateSelect?.(templatePreview!.id);
          setTemplatePreview(null);
        }}
        style={{ flex: 1 }}
      >
        Use template
      </Button>
    </View>
  </View>
</Modal>
```

> `onTemplateSelect` needs to be passed from the recording screen. Adjust the `PatientSlotCard` props interface and the calling component as needed.

- [ ] Add `Modal` to the React Native import.

- [ ] Run `npx tsc --noEmit`.

- [ ] Test on emulator: tapping a template in the recording form shows the preview sheet with name, description, and filters. Confirming sets the template.

- [ ] Commit: `feat(recording): add template preview sheet to recording form`

---

## Phase 8: Clinical Follow-Up Tools

**Delivery slot:** 8 of 9 (was "Phase 4" in previous plan)

**Prerequisite:** Phase 0 (`soapNotesApi` loaded, though follow-up tools use `recordingsApi`).

### Outcome

Completed SOAP notes support translation and client-email draft generation using existing server APIs.

### Server truth

- `POST /api/recordings/:id/translate` — confirmed. Ephemeral. Returns translated sections.
- `POST /api/recordings/:id/email-draft` — confirmed. Returns `subject`, `body`. Supports modes: `visit_summary`, `home_care`, `custom`.
- Both rely on org-level API key setup. Surface provider/quota errors clearly.

### Tasks

**8.1 — Add `recordingsApi.translate()` and `recordingsApi.generateEmailDraft()`**

Files: Modify `src/api/recordings.ts`

- [ ] Add to `src/api/recordings.ts`:

```typescript
export interface TranslatePayload {
  targetLanguage: string;
}

export interface TranslateResult {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

export type EmailDraftMode = 'visit_summary' | 'home_care' | 'custom';

export interface EmailDraftPayload {
  mode?: EmailDraftMode;
  customInstructions?: string;
}

export interface EmailDraftResult {
  subject: string;
  body: string;
}
```

Inside `recordingsApi`:
```typescript
async translate(id: string, payload: TranslatePayload): Promise<TranslateResult> {
  return apiClient.request(`/api/recordings/${id}/translate`, {
    method: 'POST',
    body: payload,
  });
},

async generateEmailDraft(id: string, payload: EmailDraftPayload = {}): Promise<EmailDraftResult> {
  return apiClient.request(`/api/recordings/${id}/email-draft`, {
    method: 'POST',
    body: payload,
  });
},
```

- [ ] Run `npx tsc --noEmit`.

- [ ] Commit: `feat(api): add recordingsApi.translate and generateEmailDraft`

---

**8.2 — Add translation UI in recording detail**

Files: Modify `app/(app)/(tabs)/recordings/[id].tsx`

- [ ] Add a `translationMutation` and a `translatedSections` state in `RecordingDetailScreen`:

```tsx
const [translatedSections, setTranslatedSections] = useState<TranslateResult | null>(null);
const [targetLanguage, setTargetLanguage] = useState('Spanish');

const translationMutation = useMutation({
  mutationFn: () => recordingsApi.translate(id!, { targetLanguage }),
  onSuccess: (data) => setTranslatedSections(data),
  onError: (error: Error) => {
    Alert.alert('Translation Failed', error instanceof ApiError ? error.message : 'Could not translate. Check org API key configuration.');
  },
});
```

- [ ] Add translation UI below the SOAP note in the `completed` status block:

```tsx
{recording.status === 'completed' && soapNote && (
  <View className="px-5 pb-4">
    <Text className="text-heading font-bold text-stone-900 mb-2" accessibilityRole="header">
      Translation
    </Text>
    <View className="flex-row items-center gap-3 mb-3">
      <TextInput
        value={targetLanguage}
        onChangeText={setTargetLanguage}
        placeholder="Target language (e.g. Spanish)"
        className="flex-1 border border-stone-300 rounded-input px-3 py-2 text-body text-stone-900"
      />
      <Button
        variant="secondary"
        size="sm"
        onPress={() => translationMutation.mutate()}
        loading={translationMutation.isPending}
      >
        Translate
      </Button>
    </View>
    {translatedSections && (
      <Card>
        {(['subjective', 'objective', 'assessment', 'plan'] as const).map((key) => (
          <View key={key} className="mb-3">
            <Text className="text-caption font-semibold text-stone-400 uppercase mb-1">{key}</Text>
            <Text className="text-body-sm text-stone-700">{translatedSections[key]}</Text>
          </View>
        ))}
      </Card>
    )}
  </View>
)}
```

- [ ] Add `TranslateResult` to the imports from `src/api/recordings.ts`.

---

**8.3 — Add email draft UI in recording detail**

Files: Modify `app/(app)/(tabs)/recordings/[id].tsx`

- [ ] Add email draft mutation and state:

```tsx
const [emailDraft, setEmailDraft] = useState<EmailDraftResult | null>(null);

const emailDraftMutation = useMutation({
  mutationFn: () => recordingsApi.generateEmailDraft(id!, { mode: 'visit_summary' }),
  onSuccess: (data) => setEmailDraft(data),
  onError: (error: Error) => {
    Alert.alert('Email Draft Failed', error instanceof ApiError ? error.message : 'Could not generate email draft. Check org API key configuration.');
  },
});
```

- [ ] Add email draft UI below the translation section:

```tsx
{recording.status === 'completed' && soapNote && (
  <View className="px-5 pb-8">
    <View className="flex-row justify-between items-center mb-2">
      <Text className="text-heading font-bold text-stone-900" accessibilityRole="header">
        Client Email Draft
      </Text>
      <Button
        variant="secondary"
        size="sm"
        onPress={() => emailDraftMutation.mutate()}
        loading={emailDraftMutation.isPending}
      >
        Generate
      </Button>
    </View>
    {emailDraft && (
      <Card>
        <Text className="text-caption font-semibold text-stone-400 uppercase mb-1">Subject</Text>
        <Text className="text-body text-stone-900 mb-3">{emailDraft.subject}</Text>
        <Text className="text-caption font-semibold text-stone-400 uppercase mb-1">Body</Text>
        <Text className="text-body-sm text-stone-700 leading-relaxed">{emailDraft.body}</Text>
        <Button
          variant="ghost"
          size="sm"
          onPress={() => { copyWithAutoClear(`Subject: ${emailDraft.subject}\n\n${emailDraft.body}`).catch(() => {}); }}
          className="mt-3 self-start"
        >
          Copy draft
        </Button>
      </Card>
    )}
  </View>
)}
```

- [ ] Import `copyWithAutoClear` from `../../../../src/lib/secureClipboard` and `EmailDraftResult` from the recordings API.

- [ ] Run `npx tsc --noEmit`.

- [ ] Test on emulator with an org that has BYOK configured. Translation and email draft should return content. Without BYOK, surface the error clearly.

- [ ] Commit: `feat(recordings): add translation and email draft UI to recording detail`

---

## Phase 9: Connectivity-Aware Upload Recovery

**Delivery slot:** 9 of 9 (was "Phase 9" in previous plan)

This phase is intentionally lower priority. Do not start until Phases 1–8 are stable.

### Outcome

Interrupted uploads recover clearly under poor clinic connectivity. In-progress uploads survive app restart.

### Current state

- Local stash support exists for unfinished recording sessions.
- No durable upload queue for submissions already in flight.

### Tasks

- [ ] Define a persisted upload queue model in `src/lib/uploadQueue.ts` separate from stash sessions. Use `expo-secure-store` or `expo-file-system` for persistence. Schema: `{ id, recordingId, segmentUris, status, attempts, createdAt }`.
- [ ] On app launch (in `AuthProvider.fetchUser()`), load the upload queue and resume any `pending` items after `setUserId()` is called — never before.
- [ ] Add explicit retry/resume UI in the recordings list for `pending` queue items.
- [ ] Add connectivity-aware error messaging using `@react-native-community/netinfo`: if upload fails and device is offline, show "No connection — will retry when reconnected" rather than a generic upload error.
- [ ] Ensure queue items are scoped by user ID (same pattern as stash storage) to prevent cross-user data leakage on shared tablets.
- [ ] On successful upload, remove the item from the queue and delete local audio files.
- [ ] Queue recovery must not violate PHI cleanup rules: if user signs out before queue drains, discard queue items for that user alongside other PHI cleanup in `handleSignOut`.

### Defaults

- "Saved for later" (stash) and "queued for upload" remain separate concepts.
- Bulk queue management UI is out of scope for v1.

---

## Cross-Cutting Requirements

These apply to every phase. An implementer must apply them without being reminded per-task.

### Hermes crash prevention

Every async operation called from a void-returning callback (`onPress`, `onValueChange`, `AppState`, `RefreshControl.onRefresh`, `Alert.onPress`) must be wrapped:

```tsx
// Required pattern
onPress={() => { doAsyncThing().catch(() => {}); }}

// Or with explicit error handling
onPress={() => { doAsyncThing().catch((e) => { if (__DEV__) console.error(e); }); }}
```

Every `Haptics.*Async()` call must have `.catch(() => {})`. Loading state resets must be in `finally` blocks.

### Query invalidation

- SOAP note mutations (`update`, `export`) → invalidate `['soapNote', id]` and `['recording', id]`
- Delete recording → invalidate `['recordings', 'list']`, navigate away
- `completeMetadata` → invalidate `['recording', id]` and `['recordings', 'list']`
- Patient edits → invalidate `['patient', id]` and `['patients', 'list']`

### PHI handling

- All note content copy uses `copyWithAutoClear` from `src/lib/secureClipboard.ts`
- No share-sheet for note content unless explicitly required
- Translation results are in-memory only — not persisted

### TypeScript

Run `npx tsc --noEmit` after every task before committing. Zero type errors is the bar.

### Console

Gate all `console.error` behind `__DEV__`. Never ship naked `console.error` calls.

---

## Validation and QA

- [ ] Patient list search returns results by patient name and by PIMS ID.
- [ ] Patient detail is reachable from both the Patients tab and from a recording detail's patient link.
- [ ] Status filter "Awaiting Details" shows only `pending_metadata` recordings.
- [ ] `pending_metadata` recording shows the metadata completion form. Submitting transitions it to processing and resumes polling.
- [ ] Support staff user cannot see the edit/delete/regenerate actions on SOAP notes.
- [ ] Authorized user can edit a SOAP section, save, and see updated content after refetch.
- [ ] Export marks the SOAP note exported and the recording detail reflects `isExported`, destination, and exporter.
- [ ] Full SOAP regeneration and single-section regeneration both refresh the note after completion.
- [ ] Delete recording removes the item from list and detail views. Back navigation lands on recordings list.
- [ ] Transcript text is visible on completed recordings that have it.
- [ ] Cost breakdown renders on recordings that have `costBreakdown`.
- [ ] Forgot-password flow sends email and shows confirmation.
- [ ] Reset-password deep link opens the reset screen. Successful reset redirects to login.
- [ ] Template preview sheet shows description, species, and appointment-type filters.
- [ ] Translation handles: success, unsupported language, missing API key, quota error.
- [ ] Email draft handles: success, missing API key, provider failure.
- [ ] All new `onPress` callbacks that call async functions have `.catch()`.
- [ ] All new `Haptics.*Async()` calls have `.catch(() => {})`.
- [ ] All loading state resets are in `finally` blocks.
- [ ] `npx tsc --noEmit` passes with zero errors across the full codebase.

---

## Explicit Assumptions

- The mobile app consumes existing backend capabilities. No new server API work is required for Phases 0–8.
- Export v1 targets on mobile are `clipboard` and `manual`. `pdf` is optional.
- Translation is read-only and non-persistent in v1.
- Client email draft generation is in scope. Sending email is out of scope.
- Template CRUD (create/edit/delete) is out of scope.
- Connectivity-aware upload queueing (Phase 9) is intentionally deprioritized.
- Password reset is the only auth recovery flow in scope. Magic links and invitation flows are out of scope.

---

## Definition of Done

This plan is complete when VetSOAP-Mobile supports:

- Direct patient directory access from the tab bar
- Status-filtered recordings list including "Awaiting Details"
- Actionable pending-metadata completion on mobile
- Transcript viewing, SOAP editing, section-level and full-note copy, export, and regeneration
- Delete recording with confirmation, respecting server permissions
- Password recovery (forgot + reset) with device deep-link handling
- Template preview during recording setup
- Optional follow-up tools: translation and client-email draft

At that point the mobile app fully covers the clinical workflow that the existing server already supports.
