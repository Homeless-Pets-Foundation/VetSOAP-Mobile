import { Paths } from 'expo-file-system';
import { ensureDirectory, safeDeleteDirectory, safeDeleteFile } from './fileOps';

const EDIT_TEMP_DIR = `${Paths.cache.uri}audio-edit/`;

export const audioTempFiles = {
  ensureDir(): void {
    ensureDirectory(EDIT_TEMP_DIR);
  },

  getTrimOutputPath(segmentIndex: number, suffix?: string): string {
    const tag = suffix ? `-${suffix}` : '';
    return `${EDIT_TEMP_DIR}trimmed-${segmentIndex}${tag}-${Date.now()}.m4a`;
  },

  getConcatOutputPath(): string {
    return `${EDIT_TEMP_DIR}concat-${Date.now()}.m4a`;
  },

  getConcatListPath(): string {
    return `${EDIT_TEMP_DIR}concat-list.txt`;
  },

  getPcmTempPath(segmentIndex: number): string {
    return `${EDIT_TEMP_DIR}pcm-${segmentIndex}-${Date.now()}.raw`;
  },

  getBatchPcmTempPath(batchIndex: number): string {
    return `${EDIT_TEMP_DIR}pcm-batch-${batchIndex}-${Date.now()}.raw`;
  },

  cleanupAll(): void {
    safeDeleteDirectory(EDIT_TEMP_DIR);
  },

  cleanupFile(uri: string): void {
    safeDeleteFile(uri);
  },
};
