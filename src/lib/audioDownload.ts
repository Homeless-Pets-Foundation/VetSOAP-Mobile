import {
  sameDownloadDescriptors,
  type DownloadManifest,
  type DownloadManifestFile,
} from '../api/downloadManifest';

export const AUDIO_DOWNLOAD_PART_TIMEOUT_MS = 30 * 60 * 1000;
const MANIFEST_REFRESH_MARGIN_MS = 60_000;

export type AudioDownloadErrorCode =
  | 'cancelled'
  | 'destination_unavailable'
  | 'file_create_failed'
  | 'http_error'
  | 'manifest_fetch_failed'
  | 'manifest_invalid'
  | 'manifest_changed'
  | 'manifest_refresh_failed'
  | 'network_failed'
  | 'part_timeout'
  | 'redirect_blocked'
  | 'size_exceeded'
  | 'size_mismatch'
  | 'source_unavailable'
  | 'write_failed';

export class AudioDownloadError extends Error {
  rollbackIncomplete = false;

  constructor(public readonly code: AudioDownloadErrorCode) {
    super('Audio download failed');
    this.name = 'AudioDownloadError';
  }
}

export interface AudioDownloadWritableFile {
  write(bytes: Uint8Array): void;
  close(): void;
  remove(): boolean;
}

export interface AudioDownloadDestination {
  listNames(): string[];
  create(filename: string, mimeType: string): AudioDownloadWritableFile;
}

export interface AudioDownloadResponse {
  status: number;
  redirected: boolean;
  finalUrl: string;
  contentLength: number | null;
  chunks: AsyncIterable<Uint8Array>;
}

export interface AudioDownloadProgress {
  bytesWritten: number;
  totalBytes: number;
  partNumber: number;
  partCount: number;
}

interface DownloadAudioOptions {
  manifest: DownloadManifest;
  destination: AudioDownloadDestination;
  refreshManifest: () => Promise<DownloadManifest>;
  fetchPart: (url: string, signal: AbortSignal) => Promise<AudioDownloadResponse>;
  signal: AbortSignal;
  onProgress?: (progress: AudioDownloadProgress) => void;
  now?: () => number;
  partTimeoutMs?: number;
}

export interface AudioDownloadResult {
  bytesWritten: number;
  partCount: number;
}

function closedError(code: AudioDownloadErrorCode): AudioDownloadError {
  return new AudioDownloadError(code);
}

function suffixTimestamp(timestampMs: number): string {
  const iso = new Date(timestampMs).toISOString();
  return iso.replace(/[-:]/g, '').replace('T', '-').replace('Z', '').replace('.', '-');
}

function withSuffix(filename: string, suffix: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0
    ? `${filename.slice(0, dot)}-${suffix}${filename.slice(dot)}`
    : `${filename}-${suffix}`;
}

/** Apply one collision suffix to the whole batch, never only the colliding part. */
export function resolveBatchDownloadFilenames(
  files: Pick<DownloadManifestFile, 'filename'>[],
  existingNames: Iterable<string>,
  nowMs: number
): string[] {
  const existing = new Set(existingNames);
  const originals = files.map((file) => file.filename);
  if (originals.every((filename) => !existing.has(filename))) return originals;

  // Millisecond precision makes a clash vanishingly unlikely. The bounded
  // increment preserves a timestamp-only suffix even if a provider already
  // contains a file created at the same millisecond.
  for (let offset = 0; offset < 1000; offset += 1) {
    const suffix = suffixTimestamp(nowMs + offset);
    const candidates = originals.map((filename) => withSuffix(filename, suffix));
    if (new Set(candidates).size === candidates.length && candidates.every((name) => !existing.has(name))) {
      return candidates;
    }
  }
  throw closedError('destination_unavailable');
}

function rollbackCreated(files: AudioDownloadWritableFile[]): boolean {
  let complete = true;
  for (let index = files.length - 1; index >= 0; index -= 1) {
    const file = files[index]!;
    try {
      file.close();
    } catch {
      // Continue to the removal attempt; close may already have succeeded.
    }
    try {
      if (!file.remove()) complete = false;
    } catch {
      complete = false;
    }
  }
  return complete;
}

async function refreshUnchangedManifest(
  baseline: DownloadManifest,
  refreshManifest: () => Promise<DownloadManifest>
): Promise<DownloadManifest> {
  let refreshed: DownloadManifest;
  try {
    refreshed = await refreshManifest();
  } catch {
    throw closedError('manifest_refresh_failed');
  }
  if (!sameDownloadDescriptors(baseline, refreshed)) {
    throw closedError('manifest_changed');
  }
  return refreshed;
}

function manifestNeedsRefresh(manifest: DownloadManifest, nowMs: number): boolean {
  const expiresAtMs = Date.parse(manifest.expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs - nowMs <= MANIFEST_REFRESH_MARGIN_MS;
}

function linkAbortSignal(source: AbortSignal, target: AbortController): () => void {
  const abort = () => target.abort();
  source.addEventListener('abort', abort);
  if (source.aborted) target.abort();
  return () => source.removeEventListener('abort', abort);
}

function safeClose(file: AudioDownloadWritableFile | null): void {
  if (!file) return;
  try {
    file.close();
  } catch {
    // The rollback path still attempts removal.
  }
}

export async function downloadAudioManifest(
  options: DownloadAudioOptions
): Promise<AudioDownloadResult> {
  const now = options.now ?? Date.now;
  const partTimeoutMs = options.partTimeoutMs ?? AUDIO_DOWNLOAD_PART_TIMEOUT_MS;
  const created: AudioDownloadWritableFile[] = [];
  let manifest = options.manifest;
  let bytesWritten = 0;
  let expiryResponseRefreshUsed = false;

  let existingNames: string[];
  try {
    existingNames = options.destination.listNames();
  } catch {
    throw closedError('destination_unavailable');
  }
  const destinationNames = resolveBatchDownloadFilenames(manifest.files, existingNames, now());

  try {
    for (let index = 0; index < manifest.files.length; index += 1) {
      if (options.signal.aborted) throw closedError('cancelled');
      if (manifestNeedsRefresh(manifest, now())) {
        manifest = await refreshUnchangedManifest(options.manifest, options.refreshManifest);
      }

      let shouldRetryAfterExpiry = true;
      while (shouldRetryAfterExpiry) {
        shouldRetryAfterExpiry = false;
        const descriptor = manifest.files[index]!;
        const controller = new AbortController();
        const unlinkAbort = linkAbortSignal(options.signal, controller);
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, partTimeoutMs);
        let target: AudioDownloadWritableFile | null = null;

        try {
          let response: AudioDownloadResponse;
          try {
            response = await options.fetchPart(descriptor.url, controller.signal);
          } catch {
            if (options.signal.aborted) throw closedError('cancelled');
            if (timedOut) throw closedError('part_timeout');
            throw closedError('network_failed');
          }

          if (
            response.redirected ||
            (response.status >= 300 && response.status < 400) ||
            response.finalUrl !== descriptor.url
          ) {
            throw closedError('redirect_blocked');
          }

          if (
            (response.status === 401 || response.status === 403) &&
            !expiryResponseRefreshUsed
          ) {
            manifest = await refreshUnchangedManifest(options.manifest, options.refreshManifest);
            expiryResponseRefreshUsed = true;
            shouldRetryAfterExpiry = true;
            continue;
          }
          if (response.status < 200 || response.status >= 300) {
            throw closedError('http_error');
          }
          if (response.contentLength !== null) {
            if (response.contentLength > descriptor.sizeBytes) throw closedError('size_exceeded');
            if (response.contentLength !== descriptor.sizeBytes) throw closedError('size_mismatch');
          }

          try {
            target = options.destination.create(destinationNames[index]!, descriptor.mimeType);
            created.push(target);
          } catch {
            throw closedError('file_create_failed');
          }

          let partBytes = 0;
          try {
            for await (const chunk of response.chunks) {
              if (options.signal.aborted) throw closedError('cancelled');
              if (timedOut) throw closedError('part_timeout');
              if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) continue;
              partBytes += chunk.byteLength;
              if (partBytes > descriptor.sizeBytes) throw closedError('size_exceeded');
              target.write(chunk);
              bytesWritten += chunk.byteLength;
              options.onProgress?.({
                bytesWritten,
                totalBytes: manifest.totalSizeBytes,
                partNumber: descriptor.partNumber,
                partCount: descriptor.partCount,
              });
            }
          } catch (error) {
            if (error instanceof AudioDownloadError) throw error;
            if (options.signal.aborted) throw closedError('cancelled');
            if (timedOut) throw closedError('part_timeout');
            throw closedError('write_failed');
          }
          if (partBytes !== descriptor.sizeBytes) throw closedError('size_mismatch');
          try {
            target.close();
          } catch {
            throw closedError('write_failed');
          }
          target = null;
        } finally {
          // Also cancel unconsumed redirect/error/oversize bodies. Aborting an
          // already-finished successful response is harmless.
          controller.abort();
          clearTimeout(timeout);
          unlinkAbort();
          safeClose(target);
        }
      }
    }

    return { bytesWritten, partCount: manifest.files.length };
  } catch (error) {
    const normalized =
      error instanceof AudioDownloadError
        ? error
        : closedError(options.signal.aborted ? 'cancelled' : 'network_failed');
    normalized.rollbackIncomplete = !rollbackCreated(created);
    throw normalized;
  }
}
