import * as SecureStore from 'expo-secure-store';
import type { StashedSession } from '../types/stash';

const MAX_STASHES = 5;
type Generation = 'a' | 'b';

// Android SecureStore limit is 2048 bytes per value.
// Use 1900 to leave margin for encoding overhead.
const CHUNK_SIZE = 1900;

const STORE_OPTIONS = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

/** Current user ID — set by AuthProvider to scope stash data per-user. */
let currentUserId: string | null = null;

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
): Promise<StashedSession[] | null> {
  const countStr = await SecureStore.getItemAsync(scopedCountKey);
  if (!countStr) return null;

  const count = parseInt(countStr, 10);
  if (isNaN(count) || count < 0) return null;
  if (count === 0) return [];

  const chunks: string[] = [];
  for (let i = 0; i < count; i++) {
    const chunk = await SecureStore.getItemAsync(`${scopedPrefix}${i}`);
    if (chunk === null) return null;
    chunks.push(chunk);
  }

  try {
    return parseSessions(chunks.join(''));
  } catch {
    return null;
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
  },

  /** Read the currently scoped user ID. Used to guard async recovery flows. */
  getUserId(): string | null {
    return currentUserId;
  },

  async getStashedSessions(): Promise<StashedSession[]> {
    const userId = currentUserId;
    if (!userId) return [];

    try {
      const activeGeneration = await SecureStore.getItemAsync(activeGenerationKeyForUser(userId));
      if (activeGeneration === 'a' || activeGeneration === 'b') {
        const activeSessions = await readSessionsForKeys(
          generationCountKeyForUser(userId, activeGeneration),
          generationPrefixForUser(userId, activeGeneration)
        );
        if (activeSessions !== null) return activeSessions;
      }

      const legacySessions = await readSessionsForKeys(
        legacyCountKeyForUser(userId),
        legacyPrefixForUser(userId)
      );
      if (legacySessions !== null) return legacySessions;

      // Last-resort recovery if the active pointer is missing but one generation is intact.
      const genBSessions = await readSessionsForKeys(
        generationCountKeyForUser(userId, 'b'),
        generationPrefixForUser(userId, 'b')
      );
      const genASessions = await readSessionsForKeys(
        generationCountKeyForUser(userId, 'a'),
        generationPrefixForUser(userId, 'a')
      );

      if (genBSessions !== null && genBSessions.length > 0) return genBSessions;
      if (genASessions !== null && genASessions.length > 0) return genASessions;
      if (genBSessions !== null) return genBSessions;
      if (genASessions !== null) return genASessions;
      return [];
    } catch {
      return [];
    }
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

      // Cleanup is best-effort after the pointer flips. A failure here should
      // not invalidate the committed generation.
      await this.deleteGeneration(activeGeneration, userId);
      await this.deleteLegacyUserScopedChunks(userId);
      return true;
    } catch {
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
