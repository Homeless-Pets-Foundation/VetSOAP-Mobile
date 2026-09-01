import { z } from 'zod';
import { parseR2BucketConfig } from '../lib/r2UploadUrl';

const MAX_DOWNLOAD_PARTS = 20;
const MAX_DOWNLOAD_PART_BYTES = 250 * 1024 * 1024;
const DOWNLOAD_URL_TTL_SECONDS = 1800;
const ENCODED_SEPARATOR_RE = /%(?:2f|5c)/i;
const AUDIO_FILENAME_EXTENSION_RE = /\.(?:aac|flac|m4a|mp3|mp4|mpeg|ogg|wav|webm)$/;
const AUDIO_EXTENSIONS_BY_MIME_TYPE: Readonly<Record<string, readonly string[]>> = {
  'audio/aac': ['aac'],
  'audio/x-aac': ['aac'],
  'audio/flac': ['flac'],
  'audio/m4a': ['m4a'],
  'audio/x-m4a': ['m4a'],
  'audio/mp3': ['mp3'],
  'audio/mp4': ['m4a', 'mp4'],
  'audio/mpeg': ['mp3', 'mpeg'],
  'audio/ogg': ['ogg'],
  'audio/wav': ['wav'],
  'audio/wave': ['wav'],
  'audio/x-wav': ['wav'],
  'audio/webm': ['webm'],
};

const DownloadManifestFileSchema = z.strictObject({
  partNumber: z.number().int().min(1).max(MAX_DOWNLOAD_PARTS),
  partCount: z.number().int().min(1).max(MAX_DOWNLOAD_PARTS),
  filename: z
    .string()
    .min(1)
    .max(220)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  mimeType: z
    .string()
    .min(1)
    .max(100)
    .refine((value) => Object.hasOwn(AUDIO_EXTENSIONS_BY_MIME_TYPE, value)),
  sizeBytes: z.number().int().positive().max(MAX_DOWNLOAD_PART_BYTES),
  url: z.string().min(1).max(8192),
});

const DownloadManifestSchema = z.strictObject({
  expiresAt: z.string().min(1).max(64),
  totalSizeBytes: z
    .number()
    .int()
    .positive()
    .max(MAX_DOWNLOAD_PARTS * MAX_DOWNLOAD_PART_BYTES),
  files: z.array(DownloadManifestFileSchema).min(1).max(MAX_DOWNLOAD_PARTS),
});

export interface DownloadManifestFile {
  partNumber: number;
  partCount: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
}

export interface DownloadManifest {
  expiresAt: string;
  totalSizeBytes: number;
  files: DownloadManifestFile[];
}

export class DownloadManifestValidationError extends Error {
  constructor(public readonly reason: string) {
    super('Invalid audio download manifest');
    this.name = 'DownloadManifestValidationError';
  }
}

function reject(reason: string): never {
  throw new DownloadManifestValidationError(reason);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rawPathOf(url: string): string {
  const schemeEnd = url.indexOf('://');
  if (schemeEnd < 0) reject('invalid_url');
  const authorityStart = schemeEnd + 3;
  const pathStart = url.indexOf('/', authorityStart);
  const queryStart = url.indexOf('?', authorityStart);
  const fragmentStart = url.indexOf('#', authorityStart);
  const endCandidates = [queryStart, fragmentStart].filter((index) => index >= 0);
  const rawEnd = endCandidates.length > 0 ? Math.min(...endCandidates) : url.length;
  if (pathStart < 0 || pathStart > rawEnd) return '';
  return url.slice(pathStart, rawEnd);
}

function validateRawPath(rawPath: string): void {
  if (!rawPath || rawPath.includes('//')) reject('ambiguous_path');
  if (ENCODED_SEPARATOR_RE.test(rawPath)) reject('encoded_separator');
  for (const segment of rawPath.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      reject('invalid_path_encoding');
    }
    if (decoded === '.' || decoded === '..') reject('dot_segment');
  }
}

function exactlyOneQueryValue(parsed: URL, expectedName: string): string {
  const matches = [...parsed.searchParams.entries()].filter(
    ([name]) => name.toLowerCase() === expectedName.toLowerCase()
  );
  if (matches.length !== 1 || matches[0]?.[0] !== expectedName) {
    reject(`invalid_${expectedName.toLowerCase().replaceAll('-', '_')}`);
  }
  return matches[0][1];
}

function parseAmzDate(value: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return null;
  }
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
    ? timestamp
    : null;
}

function validateAttachmentUrl(input: {
  url: string;
  filename: string;
  organizationId: string;
  recordingId: string;
  configuredVirtualHost: string;
  manifestExpiresAtMs: number;
}): string {
  const config = parseR2BucketConfig(input.configuredVirtualHost);
  if (!config) reject('r2_hostname_unconfigured');
  if (!input.url || input.url !== input.url.trim()) reject('invalid_url');

  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    reject('invalid_url');
  }
  if (parsed.protocol !== 'https:') reject('non_https');
  if (parsed.hostname !== config.virtualHost) reject('untrusted_r2_target');
  if (parsed.username || parsed.password) reject('credentials_forbidden');
  if (parsed.port) reject('non_default_port');
  if (parsed.hash) reject('fragment_forbidden');
  if (!parsed.search) reject('missing_signature');

  const rawPath = rawPathOf(input.url);
  validateRawPath(rawPath);
  if (parsed.pathname !== rawPath) reject('normalized_path');
  const recordingPrefix = `/recordings/${escapeRegExp(input.organizationId)}/${escapeRegExp(input.recordingId)}`;
  const objectPattern = new RegExp(
    `^${recordingPrefix}(?:\\.[A-Za-z0-9]{1,10}|_(?:[A-Za-z0-9_-]*segment[A-Za-z0-9_-]*)\\.[A-Za-z0-9]{1,10}|/[A-Za-z0-9][A-Za-z0-9_-]{0,200}\\.[A-Za-z0-9]{1,10})$`
  );
  if (!objectPattern.test(rawPath)) reject('wrong_recording_path');

  const algorithm = exactlyOneQueryValue(parsed, 'X-Amz-Algorithm');
  const credential = exactlyOneQueryValue(parsed, 'X-Amz-Credential');
  const amzDate = exactlyOneQueryValue(parsed, 'X-Amz-Date');
  const expires = exactlyOneQueryValue(parsed, 'X-Amz-Expires');
  const signedHeaders = exactlyOneQueryValue(parsed, 'X-Amz-SignedHeaders');
  const signature = exactlyOneQueryValue(parsed, 'X-Amz-Signature');
  const contentDisposition = exactlyOneQueryValue(parsed, 'response-content-disposition');
  const operation = exactlyOneQueryValue(parsed, 'x-id');

  if (algorithm !== 'AWS4-HMAC-SHA256') reject('invalid_algorithm');
  const signedAtMs = parseAmzDate(amzDate);
  if (signedAtMs === null) reject('invalid_date');
  const credentialParts = credential.split('/');
  if (
    credentialParts.length !== 5 ||
    !/^[A-Za-z0-9]{3,128}$/.test(credentialParts[0] ?? '') ||
    credentialParts[1] !== amzDate.slice(0, 8) ||
    credentialParts[2] !== 'auto' ||
    credentialParts[3] !== 's3' ||
    credentialParts[4] !== 'aws4_request'
  ) {
    reject('invalid_credential');
  }
  if (expires !== String(DOWNLOAD_URL_TTL_SECONDS)) reject('invalid_expires');
  const signedHeaderTokens = signedHeaders.split(';');
  if (
    signedHeaderTokens.some((token) => token.length === 0) ||
    new Set(signedHeaderTokens).size !== signedHeaderTokens.length ||
    !signedHeaderTokens.includes('host')
  ) {
    reject('invalid_signed_headers');
  }
  if (!/^[a-fA-F0-9]{64}$/.test(signature)) reject('invalid_signature');
  if (operation !== 'GetObject') reject('invalid_operation');
  if (contentDisposition !== `attachment; filename="${input.filename}"`) {
    reject('invalid_attachment_filename');
  }

  const signedExpiresAtMs = signedAtMs + DOWNLOAD_URL_TTL_SECONDS * 1000;
  if (input.manifestExpiresAtMs <= signedAtMs) reject('invalid_manifest_expiry');
  if (signedExpiresAtMs < input.manifestExpiresAtMs) reject('url_expires_before_manifest');
  return rawPath;
}

function expectedFilenamePattern(recordingId: string, partNumber: number, partCount: number): RegExp {
  const escapedId = escapeRegExp(recordingId);
  const width = Math.max(2, String(partCount).length);
  const part =
    partCount === 1
      ? ''
      : `-part-${String(partNumber).padStart(width, '0')}-of-${String(partCount).padStart(width, '0')}`;
  return new RegExp(
    `^Captivet-recording-\\d{4}-\\d{2}-\\d{2}-${escapedId}${part}\\.(?:aac|flac|m4a|mp3|mp4|mpeg|ogg|wav|webm)$`
  );
}

function isValidDateText(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function parseDownloadManifest(
  value: unknown,
  input: {
    recordingId: string;
    organizationId: string;
    configuredVirtualHost: string;
  }
): DownloadManifest {
  const parsed = DownloadManifestSchema.safeParse(value);
  if (!parsed.success) reject('invalid_response_shape');
  const manifest = parsed.data;
  const manifestExpiresAtMs = Date.parse(manifest.expiresAt);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(manifest.expiresAt) ||
    !Number.isFinite(manifestExpiresAtMs) ||
    new Date(manifestExpiresAtMs).toISOString() !== manifest.expiresAt
  ) {
    reject('invalid_manifest_expiry');
  }

  const total = manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (!Number.isSafeInteger(total) || total !== manifest.totalSizeBytes) {
    reject('total_size_mismatch');
  }

  const filenames = new Set<string>();
  const objectPaths = new Set<string>();
  for (const [index, file] of manifest.files.entries()) {
    if (file.partNumber !== index + 1 || file.partCount !== manifest.files.length) {
      reject('invalid_part_order');
    }
    if (!AUDIO_FILENAME_EXTENSION_RE.test(file.filename)) reject('invalid_filename_extension');
    if (!expectedFilenamePattern(input.recordingId, file.partNumber, file.partCount).test(file.filename)) {
      reject('invalid_filename');
    }
    const dateText = /^Captivet-recording-(\d{4}-\d{2}-\d{2})-/.exec(file.filename)?.[1];
    if (!dateText || !isValidDateText(dateText)) {
      reject('invalid_filename_date');
    }
    const extension = file.filename.slice(file.filename.lastIndexOf('.') + 1).toLowerCase();
    if (!AUDIO_EXTENSIONS_BY_MIME_TYPE[file.mimeType]?.includes(extension)) {
      reject('mime_extension_mismatch');
    }
    if (filenames.has(file.filename)) reject('duplicate_filename');
    filenames.add(file.filename);

    const objectPath = validateAttachmentUrl({
      url: file.url,
      filename: file.filename,
      organizationId: input.organizationId,
      recordingId: input.recordingId,
      configuredVirtualHost: input.configuredVirtualHost,
      manifestExpiresAtMs,
    });
    if (objectPaths.has(objectPath)) reject('duplicate_object_path');
    objectPaths.add(objectPath);
  }

  return manifest;
}

export function sameDownloadDescriptors(left: DownloadManifest, right: DownloadManifest): boolean {
  if (left.totalSizeBytes !== right.totalSizeBytes || left.files.length !== right.files.length) {
    return false;
  }
  return left.files.every((file, index) => {
    const next = right.files[index];
    return (
      !!next &&
      file.partNumber === next.partNumber &&
      file.partCount === next.partCount &&
      file.filename === next.filename &&
      file.mimeType === next.mimeType &&
      file.sizeBytes === next.sizeBytes &&
      new URL(file.url).pathname === new URL(next.url).pathname
    );
  });
}
