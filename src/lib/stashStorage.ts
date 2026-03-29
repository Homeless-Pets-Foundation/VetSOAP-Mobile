import * as SecureStore from 'expo-secure-store';
import type { StashedSession } from '../types/stash';

const MAX_STASHES = 5;

// Android SecureStore limit is 2048 bytes per value.
// Use 1900 to leave margin for encoding overhead.
const CHUNK_SIZE = 1900;

const STORE_OPTIONS = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

/** Current user ID — set by AuthProvider to scope stash data per-user. */
let currentUserId: string | null = null;

function keyPrefix(): string {
  if (!currentUserId) throw new Error('Stash storage: no user ID set');
  return `captivet_stash_${currentUserId}_chunk_`;
}

function countKey(): string {
  if (!currentUserId) throw new Error('Stash storage: no user ID set');
  return `captivet_stash_${currentUserId}_count`;
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

  async getStashedSessions(): Promise<StashedSession[]> {
    try {
      if (!currentUserId) return [];
      const countStr = await SecureStore.getItemAsync(countKey());
      if (!countStr) return [];

      const count = parseInt(countStr, 10);
      if (isNaN(count) || count <= 0) return [];

      const prefix = keyPrefix();
      const chunks: string[] = [];
      for (let i = 0; i < count; i++) {
        const chunk = await SecureStore.getItemAsync(`${prefix}${i}`);
        if (chunk === null) return []; // Corrupted — missing chunk
        chunks.push(chunk);
      }

      const raw = chunks.join('');
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
    } catch {
      return [];
    }
  },

  async saveStashedSessions(sessions: StashedSession[]): Promise<void> {
    try {
      // First delete old chunks
      await this.deleteAllChunks();

      const raw = JSON.stringify(sessions);
      const chunkCount = Math.ceil(raw.length / CHUNK_SIZE);
      const prefix = keyPrefix();

      // Write chunks
      for (let i = 0; i < chunkCount; i++) {
        const chunk = raw.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        await SecureStore.setItemAsync(`${prefix}${i}`, chunk, STORE_OPTIONS);
      }

      // Write count last (acts as a commit flag)
      await SecureStore.setItemAsync(countKey(), String(chunkCount), STORE_OPTIONS);
    } catch {
      // Best-effort persistence
    }
  },

  async addStashedSession(session: StashedSession): Promise<boolean> {
    try {
      const existing = await this.getStashedSessions();
      if (existing.length >= MAX_STASHES) return false;
      existing.push(session);
      await this.saveStashedSessions(existing);
      return true;
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
    try {
      if (!currentUserId) return;
      const ck = countKey();
      const countStr = await SecureStore.getItemAsync(ck);
      if (countStr) {
        const count = parseInt(countStr, 10);
        if (!isNaN(count)) {
          const prefix = keyPrefix();
          for (let i = 0; i < count; i++) {
            try { await SecureStore.deleteItemAsync(`${prefix}${i}`); } catch { /* ignore */ }
          }
        }
      }
      try { await SecureStore.deleteItemAsync(ck); } catch { /* ignore */ }
    } catch {
      // Best-effort
    }
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
