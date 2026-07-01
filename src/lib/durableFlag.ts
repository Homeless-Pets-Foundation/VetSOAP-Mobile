/**
 * Server-driven runtime flag gating NEW durable AAC capture.
 *
 * WHY server-driven (plan: Rollout And Fallback): the presign allowlist already
 * accepts audio/aac, so a premature client-side flip would upload+confirm+purge
 * locally, then fail server-side ADTS validation — stranding bytes only in R2.
 * The flag must be owned by the same deploy that ships ADTS acceptance, so a
 * client cannot enable ADTS capture against a server that cannot process it.
 *
 * Fail-safe: defaults OFF. The client caches the value from normal API responses
 * (header/body). RECOVERY/LISTING/UPLOAD/DISCARD/PURGE of EXISTING durable
 * manifests are NOT gated by this flag — only new capture + Resume->Continue.
 */

let captureEnabled = false;

/** Update the cached capture flag from a server-provided value. */
export function setDurableCaptureFlag(value: unknown): void {
  if (typeof value === 'boolean') {
    captureEnabled = value;
  } else if (typeof value === 'string') {
    captureEnabled = value === 'true' || value === '1';
  }
}

/** Whether NEW durable capture is enabled (server-driven; default false). */
export function isDurableCaptureEnabled(): boolean {
  return captureEnabled;
}

/** Test-only reset. */
export function __resetDurableCaptureFlag(): void {
  captureEnabled = false;
}
