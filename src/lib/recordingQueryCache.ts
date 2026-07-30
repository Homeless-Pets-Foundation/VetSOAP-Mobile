import type { QueryClient } from '@tanstack/react-query';
import type { Recording } from '../types';
import { validateAttentionListRow } from './attentionFeed';

/**
 * The bounded Attention Feed page. It lives under the `recordings` root so the
 * merge/remove helpers below reach it, but it is deliberately NOT disk-
 * persisted (see queryPersistence) and its rows are the NARROW
 * `AttentionRecording` projection — never a raw list row or a broad detail
 * object.
 */
export const ATTENTION_QUERY_KEY_PREFIX = ['recordings', 'attention'] as const;
export const ATTENTION_QUERY_KEY = ['recordings', 'attention', 'updated-v1'] as const;

export type RecordingCacheMutation =
  | 'draft_changed'
  | 'draft_deleted'
  | 'device_registration_recovered'
  | 'submit_success'
  | 'detail_deleted'
  | 'processing_retry'
  | 'soap_regenerated'
  | 'metadata_update';

const ATTENTION_KEY: unknown[] = [...ATTENTION_QUERY_KEY_PREFIX];

/**
 * Every mutation that can change a recording's ATTENTION-relevant source state
 * must reach the attention page too. Without it a metadata save / retry /
 * delete updates detail and the other lists but leaves an already-mounted
 * attention row stale.
 */
export function recordingInvalidationKeysFor(mutation: RecordingCacheMutation): unknown[][] {
  switch (mutation) {
    case 'draft_changed':
    case 'draft_deleted':
      return [['recordings', 'recent'], ['recordings', 'list'], ['recordings', 'drafts'], ATTENTION_KEY, ['local-drafts'], ['attention', 'local-unsent']];
    case 'device_registration_recovered':
      return [['recordings', 'recent'], ['recordings', 'list'], ['recordings', 'drafts'], ATTENTION_KEY, ['local-drafts'], ['attention', 'local-unsent']];
    case 'submit_success':
      return [['recordings', 'recent'], ['recordings', 'list'], ['recordings', 'drafts'], ATTENTION_KEY, ['local-drafts'], ['attention', 'local-unsent'], ['dashboard', 'quality']];
    case 'detail_deleted':
      return [['recordings', 'recent'], ['recordings', 'list'], ['recordings', 'drafts'], ATTENTION_KEY, ['local-drafts'], ['attention', 'local-unsent'], ['dashboard', 'quality']];
    case 'processing_retry':
    case 'soap_regenerated':
      return [['recordings', 'recent'], ['recordings', 'list'], ATTENTION_KEY, ['dashboard', 'quality']];
    case 'metadata_update':
      return [['recordings', 'recent'], ['recordings', 'list'], ATTENTION_KEY, ['dashboard', 'quality']];
    default:
      return [['recordings', 'recent'], ['recordings', 'list'], ATTENTION_KEY];
  }
}

function replaceRecordingInListPayload<T>(cached: T, updated: Recording): T {
  if (!cached || typeof cached !== 'object') return cached;

  if (Array.isArray(cached)) {
    let changed = false;
    const next = cached.map((item) => {
      if (item && typeof item === 'object' && (item as { id?: unknown }).id === updated.id) {
        changed = true;
        return { ...(item as object), ...updated };
      }
      return item;
    });
    return (changed ? next : cached) as T;
  }

  const objectCache = cached as Record<string, unknown>;
  if (Array.isArray(objectCache.data)) {
    let changed = false;
    const data = objectCache.data.map((item) => {
      if (item && typeof item === 'object' && (item as { id?: unknown }).id === updated.id) {
        changed = true;
        return { ...(item as object), ...updated };
      }
      return item;
    });
    return (changed ? { ...objectCache, data } : cached) as T;
  }

  if (Array.isArray(objectCache.pages)) {
    let changed = false;
    const pages = objectCache.pages.map((page) => {
      const updatedPage = replaceRecordingInListPayload(page, updated);
      if (updatedPage !== page) changed = true;
      return updatedPage;
    });
    return (changed ? { ...objectCache, pages } : cached) as T;
  }

  return cached;
}

/**
 * Remove an entity (matched by `id`) from a cached list payload — array,
 * `{ data: [] }`, or infinite-query `{ pages: [] }`. Returns the same
 * reference when nothing matched so React Query skips a needless re-render.
 */
function removeEntityFromListPayload<T>(cached: T, id: string): T {
  if (!cached || typeof cached !== 'object') return cached;

  if (Array.isArray(cached)) {
    const next = cached.filter(
      (item) => !(item && typeof item === 'object' && (item as { id?: unknown }).id === id)
    );
    return (next.length !== cached.length ? next : cached) as T;
  }

  const objectCache = cached as Record<string, unknown>;
  if (Array.isArray(objectCache.data)) {
    const data = objectCache.data.filter(
      (item) => !(item && typeof item === 'object' && (item as { id?: unknown }).id === id)
    );
    return (data.length !== objectCache.data.length ? { ...objectCache, data } : cached) as T;
  }

  if (Array.isArray(objectCache.pages)) {
    let changed = false;
    const pages = objectCache.pages.map((page) => {
      const updatedPage = removeEntityFromListPayload(page, id);
      if (updatedPage !== page) changed = true;
      return updatedPage;
    });
    return (changed ? { ...objectCache, pages } : cached) as T;
  }

  return cached;
}

/**
 * Purge a recording id from every cached recordings list (recent/list/drafts)
 * — used on a terminal 403/404 so a revoked/deleted recording's patient/client
 * metadata can't linger in the persisted snapshot and render offline (Codex
 * P1, PR #143).
 */
export function removeRecordingFromCachedLists(queryClient: QueryClient, id: string): void {
  for (const queryKey of [
    ['recordings', 'recent'],
    ['recordings', 'list'],
    ['recordings', 'drafts'],
    ATTENTION_KEY,
  ]) {
    queryClient.setQueriesData({ queryKey }, (cached) => removeEntityFromListPayload(cached, id));
  }
}

/**
 * Attention-cache merge. The attention envelope stores NARROW
 * `AttentionRecording` rows; spreading a broad detail mutation into it would
 * drift `errorMessage`, `errorCode`, and audio URLs back into a cache that is
 * explicitly not allowed to hold them. Rows that fail projection (or are not
 * present) leave the cache untouched.
 */
function replaceAttentionRecordingInPayload<T>(cached: T, updated: Recording): T {
  // The FULL list-boundary contract, not just the projection. A mutation
  // response is the same untrusted shape as a list row, so validating less here
  // let e.g. `review: null` replace an already-validated row — derivation could
  // then drop its only reason while the server phase still read as successful,
  // and the feed would briefly claim all-clear. A row that fails validation
  // leaves the cache untouched; the invalidation refetch is the recovery path.
  const projected = validateAttentionListRow(updated);
  if (!projected) return cached;
  if (!cached || typeof cached !== 'object') return cached;
  const objectCache = cached as Record<string, unknown>;
  if (!Array.isArray(objectCache.data)) return cached;
  let changed = false;
  const data = objectCache.data.map((item) => {
    if (item && typeof item === 'object' && (item as { id?: unknown }).id === updated.id) {
      changed = true;
      return projected;
    }
    return item;
  });
  return (changed ? { ...objectCache, data } : cached) as T;
}

/** Purge a patient id from every cached patients list (same rationale). */
export function removePatientFromCachedLists(queryClient: QueryClient, id: string): void {
  queryClient.setQueriesData({ queryKey: ['patients', 'list'] }, (cached) =>
    removeEntityFromListPayload(cached, id)
  );
}

export function mergeRecordingIntoCachedLists(queryClient: QueryClient, updated: Recording): void {
  queryClient.setQueriesData(
    { queryKey: ['recordings', 'recent'] },
    (cached) => replaceRecordingInListPayload(cached, updated)
  );
  queryClient.setQueriesData(
    { queryKey: ['recordings', 'list'] },
    (cached) => replaceRecordingInListPayload(cached, updated)
  );
  if (updated.status === 'draft') {
    queryClient.setQueriesData(
      { queryKey: ['recordings', 'drafts'] },
      (cached) => replaceRecordingInListPayload(cached, updated)
    );
  }
  queryClient.setQueriesData(
    { queryKey: ATTENTION_KEY },
    (cached) => replaceAttentionRecordingInPayload(cached, updated)
  );
}

/**
 * TERMINAL non-draft delete. The server cascades the SOAP note and tasks, so
 * leaving those persisted queries behind would keep offline clinical content
 * for a recording that no longer exists. Removing the linked patient's whole
 * cached visits prefix is safer than filtering one row out of a page and
 * leaving stale pagination totals behind.
 *
 * Purge (remove) FIRST, then invalidate summaries — and do both BEFORE
 * navigating, so no screen can render the deleted row on the way out.
 */
export function purgeDeletedRecordingCaches(
  queryClient: QueryClient,
  opts: { recordingId: string; patientId?: string | null },
): void {
  const { recordingId, patientId } = opts;
  if (!recordingId) return;

  queryClient.removeQueries({ queryKey: ['recording', recordingId] });
  queryClient.removeQueries({ queryKey: ['soapNote', recordingId] });
  queryClient.removeQueries({ queryKey: ['recordingTasks', recordingId] });
  removeRecordingFromCachedLists(queryClient, recordingId);
  if (patientId) {
    queryClient.removeQueries({ queryKey: ['patient', patientId, 'recordings'] });
  }

  invalidateRecordingCaches(queryClient, 'detail_deleted');
  if (patientId) {
    queryClient.invalidateQueries({ queryKey: ['patient', patientId] }).catch(() => {});
  }
  queryClient.invalidateQueries({ queryKey: ['patients'] }).catch(() => {});
}

export function invalidateRecordingCaches(
  queryClient: QueryClient,
  mutation: RecordingCacheMutation,
): void {
  for (const queryKey of recordingInvalidationKeysFor(mutation)) {
    queryClient
      .invalidateQueries({ queryKey, refetchType: 'active' })
      .catch(() => {});
  }
}
