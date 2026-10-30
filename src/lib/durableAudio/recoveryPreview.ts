import { File } from 'expo-file-system';
import { audioTempFiles } from '../audioTempFiles';
import { writeFilePrefix } from '../fileOps';
import { withPromiseTimeout } from '../promiseTimeout';
import { recordingActivity } from '../recordingActivity';
import { parseAdts } from './adts';
import { shouldOfferRecovery, validateManifestObject } from './manifest';
import type { DurableRecordingManifest } from './manifest';
import { AUDIO_FILENAME, buildDurableRelativePath } from './paths';
import { durableRecoveryStore } from './recoveryState';

export const RECOVERY_PREVIEW_MAX_BYTES = 1024 * 1024;
export const RECOVERY_PREVIEW_MAX_SECONDS = 60;
export const RECOVERY_PREVIEW_PREPARE_TIMEOUT_MS = 10_000;

const PREVIEW_FAILED = 'Could not prepare this preview. Please try again.';
let previewSequence = 0;

interface PreviewFileOps {
  readPrefix: (uri: string, byteLimit: number) => Promise<Uint8Array>;
  writePrefix: (sourceUri: string, destUri: string, byteCount: number) => boolean | Promise<boolean>;
}

const fileOps: PreviewFileOps = {
  async readPrefix(uri, byteLimit) {
    const file = new File(uri);
    if (!file.exists || !Number.isFinite(file.size) || file.size <= 0) throw new Error(PREVIEW_FAILED);
    const handle = file.open();
    try {
      return handle.readBytes(Math.min(byteLimit, Math.floor(file.size)));
    } finally {
      handle.close();
    }
  },
  writePrefix: writeFilePrefix,
};

function hasDurablePath(offer: DurableRecordingManifest): boolean {
  const uri = offer.audioFile.uri;
  if (/[\\\0?#]/.test(uri) || /%2f|%5c/i.test(uri)) return false;
  try {
    const path = decodeURIComponent(uri.startsWith('file://') ? uri.slice(7) : uri);
    if (!path.startsWith('/') || /[\\\0?#%]/.test(path)) return false;
    if (path.split('/').some((part) => part === '.' || part === '..')) return false;
    return path.endsWith(`/${buildDurableRelativePath(offer.userId, offer.recordingId)}/${AUDIO_FILENAME}`);
  } catch {
    return false;
  }
}

/** Read-only source preparation; the caller cleans up the returned transient file. */
export async function prepareRecoveryPreview(
  offer: DurableRecordingManifest,
  userId: string,
  signal: AbortSignal,
  io: PreviewFileOps = fileOps,
): Promise<{ uri: string; durationSeconds: number }> {
  let retired = false;
  let previewUri: string | null = null;
  const assertCurrent = () => {
    if (retired || signal.aborted || recordingActivity.isActive() ||
      offer.userId !== userId || !durableRecoveryStore.getSnapshot().includes(offer)) {
      throw new Error(PREVIEW_FAILED);
    }
  };
  assertCurrent();
  // Validation hydrates legacy proof on its input; leave the recovery offer untouched.
  const validated = validateManifestObject({ ...offer, audioFile: { ...offer.audioFile } }, { expectedUserId: userId });
  if (!validated.ok || !shouldOfferRecovery(validated.manifest) || !hasDurablePath(offer)) {
    throw new Error(PREVIEW_FAILED);
  }
  const byteLimit = Math.min(RECOVERY_PREVIEW_MAX_BYTES, Math.floor(offer.audioFile.completeFrameBytes));
  if (byteLimit <= 0) throw new Error(PREVIEW_FAILED);

  const work = (async () => {
    try {
      const bytes = await io.readPrefix(offer.audioFile.uri, byteLimit);
      assertCurrent();
      if (bytes.length > byteLimit) throw new Error(PREVIEW_FAILED);
      const parsed = parseAdts(bytes, { maxFrames: Math.floor(RECOVERY_PREVIEW_MAX_SECONDS * offer.sampleRate / 1024) });
      if (parsed.completeFrameBytes <= 0 || parsed.profile !== 2 || parsed.channels !== 1 ||
        parsed.sampleRate !== offer.sampleRate) throw new Error(PREVIEW_FAILED);
      audioTempFiles.ensureDir();
      previewUri = audioTempFiles.getTrimOutputPath(0, `recovery-preview-${++previewSequence}`).replace(/\.m4a$/, '.aac');
      if (!await io.writePrefix(offer.audioFile.uri, previewUri, parsed.completeFrameBytes)) {
        throw new Error(PREVIEW_FAILED);
      }
      assertCurrent();
      return { uri: previewUri, durationSeconds: parsed.durationMs / 1000 };
    } catch {
      if (previewUri) audioTempFiles.cleanupFile(previewUri);
      throw new Error(PREVIEW_FAILED);
    }
  })();
  let onAbort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error(PREVIEW_FAILED));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await withPromiseTimeout(
      Promise.race([work, cancelled]), RECOVERY_PREVIEW_PREPARE_TIMEOUT_MS, PREVIEW_FAILED,
    );
  } catch {
    retired = true;
    if (previewUri) audioTempFiles.cleanupFile(previewUri);
    throw new Error(PREVIEW_FAILED);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
