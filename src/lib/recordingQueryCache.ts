import type { QueryClient } from '@tanstack/react-query';
import type { Recording } from '../types';

export type RecordingCacheMutation =
  | 'review_update'
  | 'draft_changed'
  | 'draft_deleted'
  | 'device_registration_recovered'
  | 'submit_success'
  | 'detail_deleted'
  | 'processing_retry'
  | 'soap_regenerated'
  | 'metadata_update';

export function recordingInvalidationKeysFor(mutation: RecordingCacheMutation): unknown[][] {
  switch (mutation) {
    case 'review_update':
      return [['recordings', 'recent'], ['recordings', 'list']];
    case 'draft_changed':
    case 'draft_deleted':
      return [['recordings', 'recent'], ['recordings', 'list'], ['recordings', 'drafts'], ['local-drafts']];
    case 'device_registration_recovered':
      return [['recordings', 'recent'], ['recordings', 'list'], ['recordings', 'drafts'], ['local-drafts']];
    case 'submit_success':
      return [['recordings', 'recent'], ['recordings', 'list'], ['recordings', 'drafts'], ['local-drafts'], ['dashboard', 'quality']];
    case 'detail_deleted':
      return [['recordings', 'recent'], ['recordings', 'list'], ['recordings', 'drafts'], ['local-drafts'], ['dashboard', 'quality']];
    case 'processing_retry':
      return [['recordings', 'recent'], ['recordings', 'list']];
    case 'soap_regenerated':
      return [['recordings', 'recent'], ['recordings', 'list'], ['dashboard', 'quality']];
    case 'metadata_update':
      return [['recordings', 'recent'], ['recordings', 'list'], ['dashboard', 'quality']];
    default:
      return [['recordings', 'recent'], ['recordings', 'list']];
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
