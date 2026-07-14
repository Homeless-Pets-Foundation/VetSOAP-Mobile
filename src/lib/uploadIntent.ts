const MAX_UPLOAD_INTENT_ID_LENGTH = 96;

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
