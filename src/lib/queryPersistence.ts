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
function shouldPersistQuery(query: {
  queryKey: readonly unknown[];
  state: { status: string; data?: unknown };
}): boolean {
  const root = query.queryKey[0];
  if (typeof root !== 'string' || !PERSISTED_KEY_ROOTS.has(root)) return false;
  // Persist any query still holding usable data — NOT just status==='success'.
  // A hydrated query's automatic offline refetch fails and flips status to
  // 'error' with the restored data intact; requiring 'success' made the next
  // persistence write drop it, so a second offline launch lost everything
  // (Codex P2, PR #143). Queries with no data (pending, or errored before
  // ever succeeding) are still skipped.
  return query.state.data !== undefined;
}

interface ActivePersistence {
  userId: string;
  unsubscribe: () => void;
  persister: Persister;
}

let active: ActivePersistence | null = null;
// Bumped on every start/stop. persistQueryClient kicks off an async restore
// (AsyncStorage read + hydrate) that cannot be cancelled; if sign-out or a
// user switch happens while the read is still pending, the outgoing user's
// clinical queries would hydrate the shared client AFTER queryClient.clear()
// ran — exposing them on the login screen / to the next user on a shared
// tablet (Codex P1, PR #143). The guarded persister below checks this at
// restore-resolve time and discards the stale payload BEFORE hydration —
// never by clearing the shared client afterwards, which would wipe (and then
// persist an empty snapshot over) a successor scope's data (Codex P2 round 5).
let generation = 0;

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
    const restoreGeneration = ++generation;

    const persister = createAsyncStoragePersister({
      storage: AsyncStorage,
      key: storageKeyForUser(userId),
      throttleTime: 2000,
    });

    // Guard the restore payload at the moment the AsyncStorage read resolves:
    // a stale generation (scope torn down mid-read) returns undefined so
    // persistQueryClient skips hydration entirely — the payload never touches
    // the shared client.
    const guardedPersister: Persister = {
      // Best-effort like restore: the persistence subscription invokes this
      // with no observing caller, so a rejected write (storage full,
      // AsyncStorage unavailable) would be an unhandled Hermes rejection —
      // a release crash during a routine cache update (rule 4).
      persistClient: async (client) => {
        try {
          await persister.persistClient(client);
        } catch (error) {
          if (__DEV__) console.error('[queryPersistence] persist write failed:', error);
        }
      },
      restoreClient: async () => {
        // Never throw (rule 1): a corrupted/unreadable snapshot means "no
        // cache", not a crash — the app just fetches from the network.
        let restored;
        try {
          restored = await persister.restoreClient();
        } catch (error) {
          if (__DEV__) console.error('[queryPersistence] restore read failed:', error);
          return undefined;
        }
        return generation === restoreGeneration ? restored : undefined;
      },
      removeClient: () => persister.removeClient(),
    };

    const [unsubscribe, restorePromise] = persistQueryClient({
      queryClient,
      persister: guardedPersister,
      maxAge: PERSIST_MAX_AGE_MS,
      // App version + user id: an app update or user switch invalidates the
      // snapshot wholesale rather than risking shape mismatches.
      buster: `${Application.nativeApplicationVersion ?? 'dev'}:${userId}`,
      dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
    });

    // Rule 4: the restore promise must be observed — the synchronous try
    // around this function can't catch an async rejection, and an unhandled
    // rejection crashes Hermes release builds.
    Promise.resolve(restorePromise).catch((error) => {
      if (__DEV__) console.error('[queryPersistence] restore failed:', error);
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
    generation += 1; // invalidate any in-flight restore (see startQueryPersistence)
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
