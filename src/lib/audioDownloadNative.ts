import { Directory, File, type FileHandle } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import { tryDeleteFile } from './fileOps';
import type {
  AudioDownloadDestination,
  AudioDownloadResponse,
  AudioDownloadWritableFile,
} from './audioDownload';

class NativeWritableDownloadFile implements AudioDownloadWritableFile {
  private closed = false;
  private committed = false;
  private promotionUncertain = false;
  private handle: FileHandle | null = null;
  private readonly stagingUri: string;
  private readonly finalFile: File;

  constructor(
    private readonly stagingFile: File,
    directory: Directory,
    finalFilename: string
  ) {
    this.stagingUri = stagingFile.uri;
    this.finalFile = new File(directory, finalFilename);
  }

  write(bytes: Uint8Array): void {
    if (this.closed) throw new Error('Download file is closed');
    // Open lazily. The engine has already registered this staging file for
    // rollback, so an open failure cannot escape cleanup accounting.
    this.handle ??= this.stagingFile.open();
    this.handle.writeBytes(bytes);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handle?.close();
    this.handle = null;
  }

  commit(): void {
    if (this.committed) return;
    this.close();
    // Refuse a provider race instead of overwriting a file that was not part
    // of this attempt.
    if (this.finalFile.exists) throw new Error('Download destination already exists');
    try {
      this.stagingFile.move(this.finalFile);
      this.committed = true;
    } catch (error) {
      // Some document providers can report failure after creating the target.
      // Do not risk deleting a raced pre-existing file; surface incomplete
      // rollback instead so the user can inspect the folder.
      this.promotionUncertain = this.finalFile.exists;
      throw error;
    }
  }

  remove(): boolean {
    try {
      this.close();
    } catch {
      // A failed close must not skip the provider delete attempt.
    }
    const removed = tryDeleteFile(this.committed ? this.finalFile.uri : this.stagingUri);
    return removed && !this.promotionUncertain;
  }
}

class NativeAudioDownloadDestination implements AudioDownloadDestination {
  constructor(private readonly directory: Directory) {}

  listNames(): string[] {
    return this.directory.list().map((entry) => entry.name);
  }

  create(
    stagingFilename: string,
    finalFilename: string,
    mimeType: string
  ): AudioDownloadWritableFile {
    const file = this.directory.createFile(stagingFilename, mimeType);
    return new NativeWritableDownloadFile(file, this.directory, finalFilename);
  }
}

export async function pickAudioDownloadDestination(): Promise<AudioDownloadDestination> {
  const directory = await Directory.pickDirectoryAsync();
  return new NativeAudioDownloadDestination(directory);
}

async function* responseChunks(
  stream: ReadableStream<Uint8Array<ArrayBuffer>> | null
): AsyncGenerator<Uint8Array> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      if (result.value) yield result.value;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The response may have been aborted while a read was pending.
    }
  }
}

function contentLengthOf(response: Response): number | null {
  const raw = response.headers.get('content-length');
  if (!raw || !/^(?:0|[1-9]\d*)$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

export async function fetchAudioDownloadPart(
  url: string,
  signal: AbortSignal
): Promise<AudioDownloadResponse> {
  const response = await expoFetch(url, {
    method: 'GET',
    redirect: 'manual',
    signal,
  });
  return {
    status: response.status,
    redirected: response.redirected,
    finalUrl: response.url,
    contentLength: contentLengthOf(response),
    chunks: responseChunks(response.body),
  };
}

export function isDirectoryPickerCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  const classification = [candidate.name, candidate.code, candidate.message]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return classification.includes('cancel') &&
    (classification.includes('picker') || classification.includes('picking'));
}
