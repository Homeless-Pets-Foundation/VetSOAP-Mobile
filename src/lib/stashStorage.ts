import * as SecureStore from 'expo-secure-store';
import type { StashedSession } from '../types/stash';

export const MAX_STASHES = 5;
type Generation = 'a' | 'b';

// Android SecureStore limit is 2048 bytes per value.
// Use 1900 to leave margin for encoding overhead.
const CHUNK_SIZE = 1900;

const STORE_OPTIONS = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

/** Current user ID — set by AuthProvider to scope stash data per-user. */
let currentUserId: string | null = null;

// In-memory cache of the active generation's raw JSON, keyed by userId —
// the Saved Sessions list re-walks count + chunk SecureStore keys on every
// tab focus otherwise. Caching the raw string (not parsed objects) keeps the
// read path's parse + shape-validation semantics identical and hands every
// caller fresh objects. Write-through on successful save; invalidated on
// setUserId/clear/failed save. The version counter blocks a slow in-flight
// read from caching pre-write data after a concurrent write invalidated.
let stashRawCache: { userId: string; raw: string } | null = null;
let stashCacheVersion = 0;

function invalidateStashCache(): void {
  stashRawCache = null;
  stashCacheVersion++;
}

function activeGenerationKeyForUser(userId: string): string {
  return `captivet_stash_${userId}_active`;
}

function generationPrefixForUser(userId: string, generation: Generation): string {
  return `captivet_stash_${userId}_${generation}_chunk_`;
}

function generationCountKeyForUser(userId: string, generation: Generation): string {
  return `captivet_stash_${userId}_${generation}_count`;
}

function legacyPrefixForUser(userId: string): string {
  return `captivet_stash_${userId}_chunk_`;
}

function legacyCountKeyForUser(userId: string): string {
  return `captivet_stash_${userId}_count`;
}

function parseSessions(raw: string): StashedSession[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];

  // Validate shape of each stashed session to guard against corrupted data
  return parsed.filter(
    (s): s is StashedSession =>
      s != null &&
      typeof s === 'object' &&
      typeof s.id === 'string' &&
      typeof s.stashedAt === 'string' &&
      Array.isArray(s.slots) &&
      s.slots.every(
        (slot: unknown) =>
          slot != null &&
          typeof slot === 'object' &&
          typeof (slot as Record<string, unknown>).id === 'string' &&
          Array.isArray((slot as Record<string, unknown>).segments)
      )
  );
}

/**
 * Read a chunked, JSON-encoded session list for a given count/prefix key pair.
 *
 * Returns:
 *   - `null` when the generation is absent or detected as corrupt — so callers
 *     can fall through to the other generation or legacy keys.
 *   - `[]` only when the data is legitimately empty (count === 0 or the parsed
 *     list contains no valid entries).
 *
 * Treating missing chunks or invalid counts as `[]` would defeat the
 * double-buffer design: one torn write in the active generation would mask all
 * stashed sessions.
 */
async function readSessionsForKeys(
  scopedCountKey: string,
  scopedPrefix: string
): Promise<{ raw: string; sessions: StashedSession[] } | null> {
  const countStr = await SecureStore.getItemAsync(scopedCountKey);
  if (!countStr) return null;

  const count = parseInt(countStr, 10);
  if (isNaN(count) || count < 0) return null;
  if (count === 0) return { raw: '[]', sessions: [] };

  const chunks: string[] = [];
  for (let i = 0; i < count; i++) {
    const chunk = await SecureStore.getItemAsync(`${scopedPrefix}${i}`);
    if (chunk === null) return null;
    chunks.push(chunk);
  }

  try {
    const raw = chunks.join('');
    return { raw, sessions: parseSessions(raw) };
  } catch {
    return null;
  }
}

async function getStashedSessionsForUserId(
  userId: string,
  // When true, a SecureStore/Keystore READ failure re-throws instead of being
  // swallowed to []. A `[]` from the swallow is indistinguishable from "no
  // stashes", which is unsafe for a DESTRUCTIVE caller (e.g. deciding whether a
  // stash shares a durable audio file before discarding it): a read error would
  // fail-open and delete shared audio. Strict callers fail CLOSED on the throw.
  throwOnError = false,
): Promise<StashedSession[]> {
  if (!userId) return [];

  if (stashRawCache && stashRawCache.userId === userId) {
    try {
      return parseSessions(stashRawCache.raw);
    } catch {
      invalidateStashCache();
    }
  }

  try {
    const versionAtReadStart = stashCacheVersion;
    const activeGeneration = await SecureStore.getItemAsync(activeGenerationKeyForUser(userId));
    if (activeGeneration === 'a' || activeGeneration === 'b') {
      const active = await readSessionsForKeys(
        generationCountKeyForUser(userId, activeGeneration),
        generationPrefixForUser(userId, activeGeneration)
      );
      if (active !== null) {
        // Cache only the healthy active-generation path — legacy/recovery
        // fallbacks below are rare one-shot corruption paths; keep the cache
        // logic out of them. Skip populating if a write landed mid-read.
        if (stashCacheVersion === versionAtReadStart) {
          stashRawCache = { userId, raw: active.raw };
        }
        return active.sessions;
      }
    }

    const legacySessions = await readSessionsForKeys(
      legacyCountKeyForUser(userId),
      legacyPrefixForUser(userId)
    );
    if (legacySessions !== null) return legacySessions.sessions;

    // Last-resort recovery if the active pointer is missing but one generation is intact.
    const genBSessions = await readSessionsForKeys(
      generationCountKeyForUser(userId, 'b'),
      generationPrefixForUser(userId, 'b')
    );
    const genASessions = await readSessionsForKeys(
      generationCountKeyForUser(userId, 'a'),
      generationPrefixForUser(userId, 'a')
    );

    if (genBSessions !== null && genBSessions.sessions.length > 0) return genBSessions.sessions;
    if (genASessions !== null && genASessions.sessions.length > 0) return genASessions.sessions;
    if (genBSessions !== null) return genBSessions.sessions;
    if (genASessions !== null) return genASessions.sessions;
    return [];
  } catch (e) {
    // A genuinely-absent key returns null above (→ []); this catch is the actual
    // Keystore/SecureStore read FAILURE path, which strict callers must not treat
    // as "no stashes".
    if (throwOnError) throw e;
    return [];
  }
}

/**
 * Encrypted stash storage using expo-secure-store with chunked writes.
 *
 * SecureStore uses EncryptedSharedPreferences on Android and Keychain on iOS,
 * providing encryption at rest for PHI (patient names, client names, etc.).
 *
 * Android has a 2KB per-value limit, so we chunk the JSON across multiple keys.
 * Keys are scoped by user ID to prevent cross-user data leakage on shared tablets.
 */
export const stashStorage = {
  /** Set the current user ID. Must be called before any stash operations. */
  setUserId(userId: string | null): void {
    currentUserId = userId;
    invalidateStashCache();
  },

  /** Read the currently scoped user ID. Used to guard async recovery flows. */
  getUserId(): string | null {
    return currentUserId;
  },

  async getStashedSessions(): Promise<StashedSession[]> {
    const userId = currentUserId;
    if (!userId) return [];

    return getStashedSessionsForUserId(userId);
  },

  /** Read stashes for a specific user without rebinding the global stash scope. */
  async getStashedSessionsForUser(userId: string): Promise<StashedSession[]> {
    return getStashedSessionsForUserId(userId);
  },

  /**
   * Like getStashedSessions but RE-THROWS on a SecureStore/Keystore read failure
   * instead of returning []. Use before a destructive action that must fail CLOSED
   * on an ambiguous read (e.g. "does any stash share this durable audio?" before
   * discarding it) — a swallowed [] would fail-open and delete shared audio.
   */
  async getStashedSessionsStrict(): Promise<StashedSession[]> {
    const userId = currentUserId;
    if (!userId) return [];
    return getStashedSessionsForUserId(userId, true);
  },

  async saveStashedSessions(sessions: StashedSession[]): Promise<boolean> {
    const userId = currentUserId;
    if (!userId) return false;

    try {
      const activeGenerationRaw = await SecureStore.getItemAsync(activeGenerationKeyForUser(userId));
      const activeGeneration: Generation = activeGenerationRaw === 'b' ? 'b' : 'a';
      const nextGeneration: Generation = activeGeneration === 'a' ? 'b' : 'a';
      const nextCountKey = generationCountKeyForUser(userId, nextGeneration);
      const nextPrefix = generationPrefixForUser(userId, nextGeneration);

      // Always write into the inactive generation first. The active pointer
      // switches only after the new payload is fully written.
      await this.deleteGeneration(nextGeneration, userId);

      const raw = JSON.stringify(sessions);
      const chunkCount = Math.ceil(raw.length / CHUNK_SIZE);

      // Write chunks
      for (let i = 0; i < chunkCount; i++) {
        const chunk = raw.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        await SecureStore.setItemAsync(`${nextPrefix}${i}`, chunk, STORE_OPTIONS);
      }

      // Write count, then atomically switch the active pointer to the new generation.
      await SecureStore.setItemAsync(nextCountKey, String(chunkCount), STORE_OPTIONS);
      await SecureStore.setItemAsync(
        activeGenerationKeyForUser(userId),
        nextGeneration,
        STORE_OPTIONS
      );

      // Write-through: the pointer flip committed `raw` as the active
      // generation. Bump the version first so a concurrent in-flight read
      // can't repopulate over this with pre-flip data.
      stashCacheVersion++;
      stashRawCache = { userId, raw };

      // Cleanup is best-effort after the pointer flips. A failure here should
      // not invalidate the committed generation.
      await this.deleteGeneration(activeGeneration, userId);
      await this.deleteLegacyUserScopedChunks(userId);
      return true;
    } catch {
      // The inactive generation may be partially mutated; the active one is
      // untouched, but invalidating is the conservative choice.
      invalidateStashCache();
      return false;
    }
  },

  async addStashedSession(session: StashedSession): Promise<boolean> {
    try {
      const existing = await this.getStashedSessions();
      if (existing.length >= MAX_STASHES) return false;
      existing.push(session);
      return await this.saveStashedSessions(existing);
    } catch {
      return false;
    }
  },

  async removeStashedSession(id: string): Promise<void> {
    try {
      const existing = await this.getStashedSessions();
      const filtered = existing.filter((s) => s.id !== id);
      await this.saveStashedSessions(filtered);
    } catch {
      // Best-effort
    }
  },

  /**
   * Age-based eviction of stashed sessions. A stash is a deliberately-parked
   * UN-SENT recording, so this NEVER deletes silently — it only classifies by
   * age and returns the candidates so the caller can warn-first (mirror of
   * draftStorage.evictExpired). Actual removal happens only after the vet
   * acknowledges the prompt. Uses `stashedAt` for age; ignores resumed stashes
   * (pinned to an active session, not parked).
   */
  async evictExpired(opts: {
    maxAgeDays?: number;
    warnAgeDays?: number;
  }): Promise<{ expired: StashedSession[]; expiring: StashedSession[] }> {
    const expired: StashedSession[] = [];
    const expiring: StashedSession[] = [];
    const userId = currentUserId;
    if (!userId) return { expired, expiring };

    const maxAgeDays = opts.maxAgeDays ?? 30;
    const warnAgeDays = opts.warnAgeDays ?? 23;
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    try {
      const sessions = await this.getStashedSessions();
      for (const session of sessions) {
        if (session.resumedAt) continue;
        const savedMs = new Date(session.stashedAt).getTime();
        if (isNaN(savedMs)) continue; // unparseable timestamp — never evict blind
        const ageDays = (now - savedMs) / dayMs;
        if (ageDays < warnAgeDays) continue;
        if (ageDays >= maxAgeDays) {
          expired.push(session);
        } else {
          expiring.push(session);
        }
      }
    } catch {
      // Best-effort
    }

    return { expired, expiring };
  },

  async clearAllStashes(): Promise<void> {
    try {
      await this.deleteAllChunks();
    } catch {
      // Best-effort
    }
  },

  /** Delete all chunk keys and the count key from SecureStore. */
  async deleteAllChunks(): Promise<void> {
    const userId = currentUserId;
    if (!userId) return;

    try {
      await this.deleteGeneration('a', userId);
      await this.deleteGeneration('b', userId);
      await this.deleteLegacyUserScopedChunks(userId);
      try {
        await SecureStore.deleteItemAsync(activeGenerationKeyForUser(userId));
      } catch {
        /* ignore */
      }
    } catch {
      // Best-effort
    } finally {
      invalidateStashCache();
    }
  },

  async deleteGeneration(generation: Generation, userId: string): Promise<void> {
    const scopedCountKey = generationCountKeyForUser(userId, generation);
    const countStr = await SecureStore.getItemAsync(scopedCountKey);
    if (countStr) {
      const count = parseInt(countStr, 10);
      if (!isNaN(count)) {
        const scopedPrefix = generationPrefixForUser(userId, generation);
        for (let i = 0; i < count; i++) {
          try { await SecureStore.deleteItemAsync(`${scopedPrefix}${i}`); } catch { /* ignore */ }
        }
      }
    }
    try { await SecureStore.deleteItemAsync(scopedCountKey); } catch { /* ignore */ }
  },

  async deleteLegacyUserScopedChunks(userId: string): Promise<void> {
    const scopedCountKey = legacyCountKeyForUser(userId);
    const countStr = await SecureStore.getItemAsync(scopedCountKey);
    if (countStr) {
      const count = parseInt(countStr, 10);
      if (!isNaN(count)) {
        const scopedPrefix = legacyPrefixForUser(userId);
        for (let i = 0; i < count; i++) {
          try { await SecureStore.deleteItemAsync(`${scopedPrefix}${i}`); } catch { /* ignore */ }
        }
      }
    }
    try { await SecureStore.deleteItemAsync(scopedCountKey); } catch { /* ignore */ }
  },

  /**
   * Clean up legacy global (non-user-scoped) stash keys from previous versions.
   * Called once during migration to user-scoped storage.
   */
  async clearLegacyGlobalStashes(): Promise<void> {
    try {
      const legacyCountKey = 'captivet_stash_count';
      const legacyPrefix = 'captivet_stash_chunk_';
      const countStr = await SecureStore.getItemAsync(legacyCountKey);
      if (countStr) {
        const count = parseInt(countStr, 10);
        if (!isNaN(count)) {
          for (let i = 0; i < count; i++) {
            try { await SecureStore.deleteItemAsync(`${legacyPrefix}${i}`); } catch { /* ignore */ }
          }
        }
        try { await SecureStore.deleteItemAsync(legacyCountKey); } catch { /* ignore */ }
      }
    } catch {
      // Best-effort
    }
  },
};
