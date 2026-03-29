import {
  cacheDirectory,
  makeDirectoryAsync,
  deleteAsync,
  getInfoAsync,
} from 'expo-file-system/legacy';

const EDIT_TEMP_DIR = `${cacheDirectory}audio-edit/`;

export const audioTempFiles = {
  async ensureDir(): Promise<void> {
    try {
      const info = await getInfoAsync(EDIT_TEMP_DIR);
      if (!info.exists) {
        await makeDirectoryAsync(EDIT_TEMP_DIR, { intermediates: true });
      }
    } catch {
      // Best-effort
    }
  },

  getTrimOutputPath(segmentIndex: number): string {
    return `${EDIT_TEMP_DIR}trimmed-${segmentIndex}-${Date.now()}.m4a`;
  },

  getPcmTempPath(segmentIndex: number): string {
    return `${EDIT_TEMP_DIR}pcm-${segmentIndex}-${Date.now()}.raw`;
  },

  async cleanupAll(): Promise<void> {
    try {
      const info = await getInfoAsync(EDIT_TEMP_DIR);
      if (info.exists) {
        await deleteAsync(EDIT_TEMP_DIR, { idempotent: true });
      }
    } catch {
      // Best-effort cleanup
    }
  },

  async cleanupFile(uri: string): Promise<void> {
    try {
      await deleteAsync(uri, { idempotent: true });
    } catch {
      // Best-effort cleanup
    }
  },
};
