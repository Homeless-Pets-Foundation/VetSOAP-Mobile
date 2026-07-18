const MAX_UPLOAD_INTENT_ID_LENGTH = 96;
const MAX_UPLOAD_KEY_LENGTH = 128;

/** Non-security identity: timestamp + Math.random is explicitly permitted. */
export function createUploadIntentId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

/** Deterministic one-time migration for historical persisted slots. */
export function normalizeUploadIntentId(value: unknown, slotId: string): string {
  if (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_UPLOAD_INTENT_ID_LENGTH &&
    /^[\x21-\x7e]+$/.test(value)
  ) {
    return value;
  }
  return `legacy:${slotId}`.slice(0, MAX_UPLOAD_INTENT_ID_LENGTH);
}

export function slotUploadIdempotencyKey(uploadIntentId: string): string {
  return `recording-upload-v1:slot:${uploadIntentId}`;
}

export function durableUploadIdempotencyKey(recordingId: string): string {
  return `recording-upload-v1:durable:${recordingId}`;
}

/** One-time replacement identity for an explicitly approved conflict restart. */
export function createRestartUploadIdempotencyKey(): string {
  return `recording-upload-v2:restart:${createUploadIntentId()}`;
}

export function effectiveUploadIdempotencyKey(input: {
  uploadKeyOverride?: string | null;
  supersededUploadKey?: string | null;
  durableRecordingId?: string | null;
  uploadIntentId: string;
  slotId: string;
}): string {
  const uploadKeyOverride = normalizeUploadKeyOverride(input.uploadKeyOverride);
  const supersededUploadKey = normalizeSupersededUploadKey(input.supersededUploadKey);
  const hasRestartIdentity =
    (input.uploadKeyOverride !== null && input.uploadKeyOverride !== undefined) ||
    (input.supersededUploadKey !== null && input.supersededUploadKey !== undefined);
  if (hasRestartIdentity) {
    if (
      !uploadKeyOverride ||
      !supersededUploadKey ||
      uploadKeyOverride === supersededUploadKey
    ) {
      throw new Error(
        'This saved upload restart is incomplete. Check its upload status before retrying.'
      );
    }
    return uploadKeyOverride;
  }
  return input.durableRecordingId
    ? durableUploadIdempotencyKey(input.durableRecordingId)
    : slotUploadIdempotencyKey(normalizeUploadIntentId(input.uploadIntentId, input.slotId));
}

export function normalizeUploadKeyOverride(value: unknown): string | null {
  return typeof value === 'string' &&
    value.startsWith('recording-upload-v2:restart:') &&
    value.length <= MAX_UPLOAD_KEY_LENGTH &&
    /^[\x21-\x7e]+$/.test(value)
    ? value
    : null;
}

export function normalizeSupersededUploadKey(value: unknown): string | null {
  return typeof value === 'string' &&
    value.startsWith('recording-upload-v') &&
    value.length <= MAX_UPLOAD_KEY_LENGTH &&
    /^[\x21-\x7e]+$/.test(value)
    ? value
    : null;
}
