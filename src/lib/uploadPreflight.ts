import {
  createNativePreflightBatch,
  isNativePreflightTimeout,
  type NativePreflightMode,
  type NativePreflightOperation,
} from './nativePreflight';

export interface UploadFileMetadata {
  exists: boolean;
  size?: number | null;
}

type MetadataReader<T extends UploadFileMetadata> = (uri: string) => Promise<T>;

interface BatchOptions {
  timeoutMs?: number;
  now?: () => number;
}

export function throwUploadPreflightError(error: unknown): never {
  if (isNativePreflightTimeout(error)) throw error;
  if (error instanceof Error) {
    const tagged = error as Error & { uploadPhase?: 'preflight' };
    tagged.uploadPhase ??= 'preflight';
    throw tagged;
  }
  const wrapped = new Error('The recording could not be read.') as Error & {
    uploadPhase?: 'preflight';
  };
  wrapped.uploadPhase = 'preflight';
  throw wrapped;
}

export async function readUploadMetadataBatch<T extends UploadFileMetadata>(
  uris: readonly string[],
  mode: NativePreflightMode,
  operation: NativePreflightOperation,
  getMetadata: MetadataReader<T>,
  options: BatchOptions = {},
): Promise<T[]> {
  if (uris.length === 0) return [];
  const batch = createNativePreflightBatch(mode, uris.length, options);
  const result: T[] = [];
  try {
    for (const uri of uris) {
      result.push(await batch.read(operation, () => getMetadata(uri)));
    }
  } catch (error) {
    throwUploadPreflightError(error);
  }
  return result;
}

export interface DurableUploadMetadata<TManifest, TInfo> {
  manifest: TManifest;
  sourceUri: string | null;
  sourceInfo: TInfo | null;
}

export async function readDurableUploadMetadata<
  TManifest,
  TInfo extends UploadFileMetadata,
>({
  getManifest,
  sourceUriFromManifest,
  fallbackSourceUri,
  getMetadata,
  options = {},
}: {
  getManifest: () => Promise<TManifest>;
  sourceUriFromManifest: (manifest: TManifest) => string | null | undefined;
  fallbackSourceUri?: string | null;
  getMetadata: MetadataReader<TInfo>;
  options?: BatchOptions;
}): Promise<DurableUploadMetadata<TManifest, TInfo>> {
  const batch = createNativePreflightBatch('durable', 1, options);
  try {
    const manifest = await batch.read('durable_manifest', getManifest);
    const sourceUri =
      sourceUriFromManifest(manifest) ?? fallbackSourceUri ?? null;
    const sourceInfo = sourceUri
      ? await batch.read('source_metadata', () => getMetadata(sourceUri))
      : null;
    return { manifest, sourceUri, sourceInfo };
  } catch (error) {
    throwUploadPreflightError(error);
  }
}

export interface PendingDurableAvailability<TManifest> {
  manifest: TManifest | null;
  sourceUri: string | null;
  hasCompleteLocalAudio: boolean;
}

/**
 * Pending-confirm probes fail open to confirmation-only recovery for ordinary
 * missing/read failures, but fail closed for the typed native timeout.
 */
export async function probePendingDurableAvailability<
  TManifest,
  TInfo extends UploadFileMetadata,
>({
  getManifest,
  sourceUriFromManifest,
  fallbackSourceUri,
  getMetadata,
  options = {},
}: {
  getManifest: () => Promise<TManifest>;
  sourceUriFromManifest: (manifest: TManifest) => string | null | undefined;
  fallbackSourceUri?: string | null;
  getMetadata: MetadataReader<TInfo>;
  options?: BatchOptions;
}): Promise<PendingDurableAvailability<TManifest>> {
  const batch = createNativePreflightBatch('durable', 1, options);
  let manifest: TManifest | null = null;
  try {
    manifest = await batch.read('durable_manifest', getManifest);
  } catch (error) {
    if (isNativePreflightTimeout(error)) throw error;
  }

  const sourceUri =
    (manifest ? sourceUriFromManifest(manifest) : null) ??
    fallbackSourceUri ??
    null;
  if (!sourceUri) {
    return { manifest, sourceUri: null, hasCompleteLocalAudio: false };
  }

  try {
    const info = await batch.read('source_metadata', () =>
      getMetadata(sourceUri),
    );
    return {
      manifest,
      sourceUri,
      hasCompleteLocalAudio: info.exists && (info.size ?? 0) > 0,
    };
  } catch (error) {
    if (isNativePreflightTimeout(error)) throw error;
    return { manifest, sourceUri, hasCompleteLocalAudio: false };
  }
}

export async function probePendingStandardAvailability<
  TInfo extends UploadFileMetadata,
>(
  uris: readonly string[],
  getMetadata: MetadataReader<TInfo>,
  options: BatchOptions = {},
): Promise<boolean> {
  if (uris.length === 0) return false;
  const batch = createNativePreflightBatch('standard', uris.length, options);
  try {
    for (const uri of uris) {
      const info = await batch.read('segment_metadata', () =>
        getMetadata(uri),
      );
      if (!info.exists || !(info.size ?? 0)) return false;
    }
    return true;
  } catch (error) {
    if (isNativePreflightTimeout(error)) throw error;
    return false;
  }
}
