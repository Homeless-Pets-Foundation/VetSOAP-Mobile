import * as SecureStore from 'expo-secure-store';
import type { StashedSession } from '../types/stash';

const KEY_PREFIX = 'captivet_stash_chunk_';
const COUNT_KEY = 'captivet_stash_count';
const MAX_STASHES = 5;

// Android SecureStore limit is 2048 bytes per value.
// Use 1900 to leave margin for encoding overhead.
const CHUNK_SIZE = 1900;

const STORE_OPTIONS = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

/**
 * Encrypted stash storage using expo-secure-store with chunked writes.
 *
 * SecureStore uses EncryptedSharedPreferences on Android and Keychain on iOS,
 * providing encryption at rest for PHI (patient names, client names, etc.).
 *
 * Android has a 2KB per-value limit, so we chunk the JSON across multiple keys.
 */
export const stashStorage = {
  async getStashedSessions(): Promise<StashedSession[]> {
    try {
      const countStr = await SecureStore.getItemAsync(COUNT_KEY);
      if (!countStr) return [];

      const count = parseInt(countStr, 10);
      if (isNaN(count) || count <= 0) return [];

      const chunks: string[] = [];
      for (let i = 0; i < count; i++) {
        const chunk = await SecureStore.getItemAsync(`${KEY_PREFIX}${i}`);
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

      // Write chunks
      for (let i = 0; i < chunkCount; i++) {
        const chunk = raw.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        await SecureStore.setItemAsync(`${KEY_PREFIX}${i}`, chunk, STORE_OPTIONS);
      }

      // Write count last (acts as a commit flag)
      await SecureStore.setItemAsync(COUNT_KEY, String(chunkCount), STORE_OPTIONS);
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
      const countStr = await SecureStore.getItemAsync(COUNT_KEY);
      if (countStr) {
        const count = parseInt(countStr, 10);
        if (!isNaN(count)) {
          for (let i = 0; i < count; i++) {
            try { await SecureStore.deleteItemAsync(`${KEY_PREFIX}${i}`); } catch { /* ignore */ }
          }
        }
      }
      try { await SecureStore.deleteItemAsync(COUNT_KEY); } catch { /* ignore */ }
    } catch {
      // Best-effort
    }
  },
};
