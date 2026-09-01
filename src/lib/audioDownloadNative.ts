import { Directory, type FileHandle } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import { safeDeleteFile, tryDeleteFile } from './fileOps';
import type {
  AudioDownloadDestination,
  AudioDownloadResponse,
  AudioDownloadWritableFile,
} from './audioDownload';

class NativeWritableDownloadFile implements AudioDownloadWritableFile {
  private closed = false;

  constructor(
    private readonly uri: string,
    private readonly handle: FileHandle
  ) {}

  write(bytes: Uint8Array): void {
    if (this.closed) throw new Error('Download file is closed');
    this.handle.writeBytes(bytes);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handle.close();
  }

  remove(): boolean {
    try {
      this.close();
    } catch {
      // A failed close must not skip the provider delete attempt.
    }
    return tryDeleteFile(this.uri);
  }
}

class NativeAudioDownloadDestination implements AudioDownloadDestination {
  constructor(private readonly directory: Directory) {}

  listNames(): string[] {
    return this.directory.list().map((entry) => entry.name);
  }

  create(filename: string, mimeType: string): AudioDownloadWritableFile {
    const file = this.directory.createFile(filename, mimeType);
    try {
      return new NativeWritableDownloadFile(file.uri, file.open());
    } catch {
      safeDeleteFile(file.uri);
      throw new Error('Could not create download file');
    }
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
