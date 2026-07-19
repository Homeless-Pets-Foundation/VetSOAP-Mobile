const R2_SUFFIX = '.r2.cloudflarestorage.com';
const MAX_PRESIGN_EXPIRES_SECONDS = 1800;
const BUCKET_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/;
const ENCODED_SEPARATOR_RE = /%(?:2f|5c)/i;

export type R2UploadUrlStyle = 'virtual_hosted' | 'path_style';

export interface R2BucketConfig {
  bucketName: string;
  accountId: string;
  virtualHost: string;
  accountHost: string;
}

export interface ValidatedR2UploadUrl {
  style: R2UploadUrlStyle;
  host: string;
  objectPath: string;
}

export class R2UploadUrlValidationError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'R2UploadUrlValidationError';
  }
}

function reject(reason: string): never {
  throw new R2UploadUrlValidationError(reason);
}

/**
 * Parse the production EAS value without throwing. The configured value is the
 * canonical virtual bucket hostname, never the bare R2 account hostname.
 */
export function parseR2BucketConfig(hostname: string): R2BucketConfig | null {
  if (!hostname || hostname !== hostname.trim() || hostname !== hostname.toLowerCase()) {
    return null;
  }
  if (hostname.includes('/') || hostname.includes(':') || !hostname.endsWith(R2_SUFFIX)) {
    return null;
  }

  const labels = hostname.split('.');
  if (
    labels.length !== 5 ||
    labels[2] !== 'r2' ||
    labels[3] !== 'cloudflarestorage' ||
    labels[4] !== 'com'
  ) {
    return null;
  }

  const bucketName = labels[0] ?? '';
  const accountId = labels[1] ?? '';
  if (!BUCKET_NAME_RE.test(bucketName) || !ACCOUNT_ID_RE.test(accountId)) {
    return null;
  }

  return {
    bucketName,
    accountId,
    virtualHost: hostname,
    accountHost: `${accountId}.r2.cloudflarestorage.com`,
  };
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

function getExactlyOneQueryValue(parsed: URL, expectedName: string): string {
  const matches = [...parsed.searchParams.entries()].filter(
    ([name]) => name.toLowerCase() === expectedName.toLowerCase()
  );
  if (matches.length !== 1 || matches[0]?.[0] !== expectedName) {
    reject(`invalid_${expectedName.toLowerCase().replaceAll('-', '_')}`);
  }
  return matches[0][1];
}

function isValidAmzDate(value: string): boolean {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  const [year, month, day, hour, minute, second] = parts;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

/**
 * Strictly validate the structure of an R2 SigV4 upload URL. This does not and
 * cannot verify the signature cryptographically; R2 remains authoritative.
 * Device wall-clock time is deliberately not consulted.
 */
export function validateR2PresignedUploadUrl(
  url: string,
  configuredVirtualHost: string
): ValidatedR2UploadUrl {
  const config = parseR2BucketConfig(configuredVirtualHost);
  if (!config) reject('r2_hostname_unconfigured');
  if (!url || url !== url.trim()) reject('invalid_url');

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    reject('invalid_url');
  }

  if (parsed.protocol !== 'https:') reject('non_https');
  if (parsed.username || parsed.password) reject('credentials_forbidden');
  if (parsed.port) reject('non_default_port');
  if (parsed.hash) reject('fragment_forbidden');
  if (!parsed.search) reject('missing_signature');

  const rawPath = rawPathOf(url);
  validateRawPath(rawPath);
  if (parsed.pathname !== rawPath) reject('normalized_path');

  let style: R2UploadUrlStyle;
  let objectPath: string;
  const virtualPrefix = '/recordings/';
  const pathStylePrefix = `/${config.bucketName}/recordings/`;
  if (parsed.hostname === config.virtualHost && rawPath.startsWith(virtualPrefix)) {
    style = 'virtual_hosted';
    objectPath = rawPath.slice(virtualPrefix.length);
  } else if (parsed.hostname === config.accountHost && rawPath.startsWith(pathStylePrefix)) {
    style = 'path_style';
    objectPath = rawPath.slice(pathStylePrefix.length);
  } else {
    reject('untrusted_r2_target');
  }
  if (!objectPath) reject('empty_object_key');

  const algorithm = getExactlyOneQueryValue(parsed, 'X-Amz-Algorithm');
  const credential = getExactlyOneQueryValue(parsed, 'X-Amz-Credential');
  const amzDate = getExactlyOneQueryValue(parsed, 'X-Amz-Date');
  const expires = getExactlyOneQueryValue(parsed, 'X-Amz-Expires');
  const signedHeaders = getExactlyOneQueryValue(parsed, 'X-Amz-SignedHeaders');
  const signature = getExactlyOneQueryValue(parsed, 'X-Amz-Signature');

  if (algorithm !== 'AWS4-HMAC-SHA256') reject('invalid_algorithm');
  if (!credential.trim()) reject('invalid_credential');
  if (!isValidAmzDate(amzDate)) reject('invalid_date');
  if (!/^[1-9]\d*$/.test(expires)) reject('invalid_expires');
  const expiresSeconds = Number(expires);
  if (
    !Number.isSafeInteger(expiresSeconds) ||
    expiresSeconds < 1 ||
    expiresSeconds > MAX_PRESIGN_EXPIRES_SECONDS
  ) {
    reject('invalid_expires');
  }
  const signedHeaderTokens = signedHeaders.split(';');
  if (
    signedHeaderTokens.some((token) => token.length === 0) ||
    !signedHeaderTokens.includes('host')
  ) {
    reject('invalid_signed_headers');
  }
  if (!/^[a-fA-F0-9]{64}$/.test(signature)) reject('invalid_signature');

  return {
    style,
    host: parsed.hostname,
    objectPath,
  };
}
