/**
 * Random-bytes helpers. Hermes on iOS in Expo SDK 55 / RN 0.83.4 does not
 * expose `globalThis.crypto.getRandomValues` despite Hermes docs claiming
 * it since 0.76, so every security-critical caller must prefer
 * `expo-crypto.getRandomBytes` and treat the global as a fallback only.
 *
 * See CLAUDE.md rule 26 for the incident that motivates this module.
 */

type ExpoCryptoModule = { getRandomBytes?: (n: number) => Uint8Array };

function fillFromExpoCrypto(bytes: Uint8Array): boolean {
  try {
    // expo-crypto is a linked native module; static import would crash on
    // cold start if an old dev-client APK lacks the native side (CLAUDE.md
    // rule 23). Lazy require keeps the file loadable and degrades to the
    // global crypto fallback below.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-crypto') as ExpoCryptoModule;
    if (mod.getRandomBytes) {
      bytes.set(mod.getRandomBytes(bytes.length));
      return true;
    }
  } catch {
    // expo-crypto not installed / not linked — fall through.
  }
  return false;
}

function fillFromGlobalCrypto(bytes: Uint8Array): boolean {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
    return true;
  }
  return false;
}

/**
 * Security-critical random bytes. Tries expo-crypto first, then the global
 * crypto, and throws if neither is available. Never falls back to
 * `Math.random` — callers of this function rely on cryptographic quality
 * (path-validation boundaries, nonces, device IDs).
 */
export function getSecureRandomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  if (fillFromExpoCrypto(bytes)) return bytes;
  if (fillFromGlobalCrypto(bytes)) return bytes;
  throw new Error('No cryptographic random source available');
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function formatUuidV4(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * UUID v4 for the idempotency-key use case in `src/api/recordings.ts`.
 * Falls back to `Math.random` if no crypto source is available (see CLAUDE.md
 * rule 26 — idempotency keys are explicitly allowed this fallback because
 * collision means at worst a retried request looking like a fresh one, not
 * a security boundary break). For security-critical UUIDs (device id), use
 * `getSecureRandomBytes(16)` and `formatUuidV4FromSecureBytes`.
 */
export function getIdempotencyUuid(): string {
  const bytes = new Uint8Array(16);
  if (fillFromExpoCrypto(bytes) || fillFromGlobalCrypto(bytes)) {
    return formatUuidV4(bytes);
  }
  for (let i = 0; i < 16; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return formatUuidV4(bytes);
}

/** Security-critical UUID v4. Throws if no crypto source. */
export function getSecureUuid(): string {
  return formatUuidV4(getSecureRandomBytes(16));
}

/** Hex-encode n random bytes from a secure source. Throws if unavailable. */
export function getSecureRandomHex(n: number): string {
  return bytesToHex(getSecureRandomBytes(n));
}
