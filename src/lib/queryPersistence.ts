import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Application from 'expo-application';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { persistQueryClient, type Persister } from '@tanstack/react-query-persist-client';
import { queryClient } from './queryClient';

/**
 * Offline persistence for completed clinical reads (2026-07 audit WP28).
 *
 * A vet opening the app offline (barn call, basement exam room) used to see
 * "Failed to load" / empty lists because the React Query cache was
 * memory-only. Disk caching is acceptable per the 2026-05-29 owner decision
 * (vet recordings are not HIPAA; drafts already persist on disk), but is
 * user-scoped like draftStorage (rule 13): the storage key embeds the user
 * id, activation waits until auth resolves, and sign-out/user-switch removes
 * the outgoing user's snapshot in addition to queryClient.clear().
 *
 * Only allowlisted query keys are dehydrated — never auth/session/device/
 * billing state.
 */

/** 7 days — matches the persisted snapshot's maxAge. */
export const PERSIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * gcTime for queries that should survive into the persisted snapshot.
 * React Query never dehydrates a query past its gcTime, so the allowlisted
 * consumer queries opt into this instead of the global 10-minute default.
 */
export const PERSIST_GC_TIME_MS = PERSIST_MAX_AGE_MS;

const PERSISTED_KEY_ROOTS = new Set([
  'recordings', // list pages
  'recording', // detail
  'soapNote',
  'recordingTasks',
  'patients', // list
  'patient', // detail + visits
]);

// Structural param type: npm may nest a second @tanstack/query-core under
// query-persist-client-core, and the two nominal Query types don't unify.
function shouldPersistQuery(query: { queryKey: readonly unknown[]; state: { status: string } }): boolean {
  const root = query.queryKey[0];
  if (typeof root !== 'string' || !PERSISTED_KEY_ROOTS.has(root)) return false;
  // Only successful data is worth a disk write; errors/refetch state are not.
  return query.state.status === 'success';
}

interface ActivePersistence {
  userId: string;
  unsubscribe: () => void;
  persister: Persister;
}

let active: ActivePersistence | null = null;

function storageKeyForUser(userId: string): string {
  return `captivet_rq_cache_${userId}`;
}

/**
 * Begin persisting the shared queryClient for this user. Idempotent per
 * user; switching users tears down the previous subscription first. Never
 * throws (rule 1) — persistence is an enhancement, not a dependency.
 */
export function startQueryPersistence(userId: string): void {
  try {
    if (!userId) return;
    if (active?.userId === userId) return;
    stopQueryPersistence({ removeStored: false });

    const persister = createAsyncStoragePersister({
      storage: AsyncStorage,
      key: storageKeyForUser(userId),
      throttleTime: 2000,
    });

    const [unsubscribe] = persistQueryClient({
      queryClient,
      persister,
      maxAge: PERSIST_MAX_AGE_MS,
      // App version + user id: an app update or user switch invalidates the
      // snapshot wholesale rather than risking shape mismatches.
      buster: `${Application.nativeApplicationVersion ?? 'dev'}:${userId}`,
      dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
    });

    active = { userId, unsubscribe, persister };
  } catch (error) {
    if (__DEV__) console.error('[queryPersistence] start failed:', error);
  }
}

/**
 * Stop persisting; with removeStored, also delete the outgoing user's
 * snapshot (sign-out path — the persisted cache is a transient cache per
 * rule 8, unlike drafts, and must not survive to the next user).
 */
export function stopQueryPersistence(opts: { removeStored: boolean }): void {
  try {
    const current = active;
    active = null;
    current?.unsubscribe();
    if (opts.removeStored && current) {
      Promise.resolve(current.persister.removeClient()).catch(() => {});
    }
  } catch (error) {
    if (__DEV__) console.error('[queryPersistence] stop failed:', error);
  }
}
