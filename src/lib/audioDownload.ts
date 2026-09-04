import {
  sameDownloadDescriptors,
  type DownloadManifest,
  type DownloadManifestFile,
} from '../api/downloadManifest';
import { withPromiseTimeout } from './promiseTimeout';

export const AUDIO_DOWNLOAD_PART_TIMEOUT_MS = 30 * 60 * 1000;
// ApiClient's fetch deadline ends before its async 401 refresh callback. Keep
// the complete manifest operation bounded even if that callback/native auth
// bridge never settles.
export const AUDIO_DOWNLOAD_MANIFEST_REQUEST_TIMEOUT_MS = 45 * 1000;
// The server guarantees at least 17 minutes of URL lifetime when it returns a
// manifest. Refresh from elapsed time since receipt, not the device wall clock.
export const AUDIO_DOWNLOAD_MANIFEST_REFRESH_AFTER_MS = 16 * 60 * 1000;

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
  /**
   * Idempotent once the underlying handle has closed. If a previous close
   * threw, calling again retries the native close so rollback can still
   * release the file before deleting it.
   */
  close(): void;
  /** Promote the verified staging file to its final user-visible filename. */
  commit(): void;
  remove(): boolean;
}

export interface AudioDownloadDestination {
  listNames(): string[];
  create(
    stagingFilename: string,
    finalFilename: string,
    mimeType: string
  ): AudioDownloadWritableFile;
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
  /** Wall-clock time used only for PHI-free collision suffixes. */
  now?: () => number;
  /** Monotonic elapsed time used for manifest refresh scheduling. */
  elapsedNow?: () => number;
  manifestRefreshAfterMs?: number;
  partTimeoutMs?: number;
}

export interface AudioDownloadResult {
  bytesWritten: number;
  partCount: number;
}

interface PartGuard {
  deadline: Promise<never>;
  dispose(): void;
}

function closedError(code: AudioDownloadErrorCode): AudioDownloadError {
  return new AudioDownloadError(code);
}

/**
 * Bound the complete API/auth operation and let download cancellation win the
 * race. Both settlement handlers remain attached after cancellation or timeout
 * so a late auth-refresh rejection cannot become an unhandled Hermes error.
 */
export function waitForAudioDownloadManifest(
  request: Promise<DownloadManifest>,
  signal: AbortSignal,
  timeoutMs = AUDIO_DOWNLOAD_MANIFEST_REQUEST_TIMEOUT_MS
): Promise<DownloadManifest> {
  const bounded = withPromiseTimeout(
    request,
    timeoutMs,
    'Audio download manifest request timed out',
    () => closedError('manifest_fetch_failed')
  );

  return new Promise<DownloadManifest>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(closedError('cancelled')));

    // Observe both branches before checking an already-aborted signal.
    bounded.then(
      (manifest) => finish(() => resolve(manifest)),
      (error) => finish(() => reject(error))
    );
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function monotonicNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
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

  for (let offset = 0; offset < 1000; offset += 1) {
    const suffix = suffixTimestamp(nowMs + offset);
    const candidates = originals.map((filename) => withSuffix(filename, suffix));
    if (
      new Set(candidates).size === candidates.length &&
      candidates.every((name) => !existing.has(name))
    ) {
      return candidates;
    }
  }
  throw closedError('destination_unavailable');
}

function resolveStagingFilenames(
  count: number,
  existingNames: Iterable<string>,
  finalNames: Iterable<string>,
  nowMs: number
): string[] {
  const unavailable = new Set([...existingNames, ...finalNames]);
  const width = Math.max(2, String(count).length);
  for (let offset = 0; offset < 1000; offset += 1) {
    const batch = suffixTimestamp(nowMs + offset);
    const candidates = Array.from(
      { length: count },
      (_, index) =>
        `Captivet-audio-download-${batch}-part-${String(index + 1).padStart(width, '0')}.partial`
    );
    if (candidates.every((name) => !unavailable.has(name))) return candidates;
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
  } catch (error) {
    // The user's own cancellation must survive the refresh unchanged so the
    // caller treats it as a cancellation rather than a refresh failure.
    if (error instanceof AudioDownloadError && error.code === 'cancelled') throw error;
    throw closedError('manifest_refresh_failed');
  }
  if (!sameDownloadDescriptors(baseline, refreshed)) {
    throw closedError('manifest_changed');
  }
  return refreshed;
}

function createPartGuard(
  sourceSignal: AbortSignal,
  targetController: AbortController,
  timeoutMs: number
): PartGuard {
  let active = true;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let rejectDeadline!: (error: AudioDownloadError) => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  // A successful part disposes the guard before it rejects. This handler also
  // keeps an immediate/late guard rejection observed outside Promise.race.
  void deadline.catch(() => {});

  const stop = (code: 'cancelled' | 'part_timeout') => {
    if (!active) return;
    active = false;
    targetController.abort();
    rejectDeadline(closedError(code));
  };
  const onAbort = () => stop('cancelled');
  sourceSignal.addEventListener('abort', onAbort, { once: true });
  if (sourceSignal.aborted) {
    onAbort();
  } else {
    timeout = setTimeout(() => stop('part_timeout'), Math.max(0, timeoutMs));
  }

  return {
    deadline,
    dispose() {
      active = false;
      if (timeout !== null) clearTimeout(timeout);
      sourceSignal.removeEventListener('abort', onAbort);
    },
  };
}

function settleBeforeGuard<T>(operation: Promise<T>, guard: PartGuard): Promise<T> {
  // The operation may be an uncancellable native bridge call. Observe its late
  // rejection after the guard has already returned control to the UI.
  void operation.catch(() => {});
  return Promise.race([operation, guard.deadline]);
}

function observeIteratorReturn(iterator: AsyncIterator<Uint8Array>): void {
  try {
    const returned = iterator.return?.();
    if (returned) void Promise.resolve(returned).catch(() => {});
  } catch {
    // The response controller is aborted separately.
  }
}

export async function downloadAudioManifest(
  options: DownloadAudioOptions
): Promise<AudioDownloadResult> {
  const now = options.now ?? Date.now;
  const elapsedNow = options.elapsedNow ?? monotonicNow;
  const refreshAfterMs =
    options.manifestRefreshAfterMs ?? AUDIO_DOWNLOAD_MANIFEST_REFRESH_AFTER_MS;
  const partTimeoutMs = options.partTimeoutMs ?? AUDIO_DOWNLOAD_PART_TIMEOUT_MS;
  const created: AudioDownloadWritableFile[] = [];
  let manifest = options.manifest;
  let manifestReceivedAtMs = elapsedNow();
  let bytesWritten = 0;
  let expiryResponseRefreshUsed = false;

  let existingNames: string[];
  try {
    existingNames = options.destination.listNames();
  } catch {
    throw closedError('destination_unavailable');
  }
  const batchTimestamp = now();
  const destinationNames = resolveBatchDownloadFilenames(
    manifest.files,
    existingNames,
    batchTimestamp
  );
  const stagingNames = resolveStagingFilenames(
    manifest.files.length,
    existingNames,
    destinationNames,
    batchTimestamp
  );

  try {
    for (let index = 0; index < manifest.files.length; index += 1) {
      if (options.signal.aborted) throw closedError('cancelled');
      if (elapsedNow() - manifestReceivedAtMs >= refreshAfterMs) {
        manifest = await refreshUnchangedManifest(options.manifest, options.refreshManifest);
        manifestReceivedAtMs = elapsedNow();
      }

      let shouldRetryAfterExpiry = true;
      while (shouldRetryAfterExpiry) {
        shouldRetryAfterExpiry = false;
        const descriptor = manifest.files[index]!;
        const controller = new AbortController();
        const guard = createPartGuard(options.signal, controller, partTimeoutMs);
        let target: AudioDownloadWritableFile | null = null;
        let iterator: AsyncIterator<Uint8Array> | null = null;

        try {
          let response: AudioDownloadResponse;
          try {
            response = await settleBeforeGuard(
              options.fetchPart(descriptor.url, controller.signal),
              guard
            );
          } catch (error) {
            if (error instanceof AudioDownloadError) throw error;
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
            manifestReceivedAtMs = elapsedNow();
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
            target = options.destination.create(
              stagingNames[index]!,
              destinationNames[index]!,
              descriptor.mimeType
            );
            // Register the staging file before its first open/write so that an
            // open failure is included in verified rollback reporting.
            created.push(target);
          } catch {
            throw closedError('file_create_failed');
          }

          let partBytes = 0;
          iterator = response.chunks[Symbol.asyncIterator]();
          while (true) {
            let next: IteratorResult<Uint8Array>;
            try {
              next = await settleBeforeGuard(Promise.resolve(iterator.next()), guard);
            } catch (error) {
              // A stream that drops after headers is a transport fault, not a
              // destination write failure; keep the error-code breakdown honest.
              if (error instanceof AudioDownloadError) throw error;
              throw closedError('network_failed');
            }
            if (next.done) break;
            const chunk = next.value;
            if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) continue;
            partBytes += chunk.byteLength;
            if (partBytes > descriptor.sizeBytes) throw closedError('size_exceeded');
            try {
              target.write(chunk);
            } catch {
              throw closedError('write_failed');
            }
            bytesWritten += chunk.byteLength;
            options.onProgress?.({
              bytesWritten,
              totalBytes: manifest.totalSizeBytes,
              partNumber: descriptor.partNumber,
              partCount: descriptor.partCount,
            });
          }
          if (partBytes !== descriptor.sizeBytes) throw closedError('size_mismatch');
          try {
            target.close();
          } catch {
            throw closedError('write_failed');
          }
          target = null;
          iterator = null;
        } finally {
          controller.abort();
          guard.dispose();
          if (iterator) observeIteratorReturn(iterator);
          try {
            target?.close();
          } catch {
            // The outer rollback still attempts provider deletion.
          }
        }
      }
    }

    // No final filename becomes visible until every part has passed its exact
    // byte-count check. A crash can therefore leave only unmistakable partials,
    // never a truncated file that looks like a completed original.
    for (const file of created) {
      try {
        file.commit();
      } catch {
        throw closedError('write_failed');
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
