/**
 * Pure upload-retry helpers — extracted from recordings.ts so the decision
 * logic can be unit-tested via node:test's vm-based loadTsModule pattern
 * without dragging in expo-file-system / native-only imports. The runtime
 * retry loop itself stays in recordings.ts because it depends on
 * breadcrumb() and waitForNetworkOnline(); only the predicates +
 * type plumbing live here.
 *
 * recordings.ts re-exports the public surface so existing callers
 * (record.tsx, anything importing from '../api/recordings') keep working.
 */

/**
 * Phase label attached to thrown Errors from the upload pipeline so callers
 * (uploadSlot) can classify the failure without fragile message matching.
 * Kept as a union string rather than an enum to stay trivially JSON-safe
 * for telemetry payloads.
 */
export type UploadPhase =
  | 'preflight'
  | 'silent_check'
  | 'patch_draft'
  | 'presign'
  | 'r2_put'
  | 'confirm'
  | 'create_draft'
  | 'unknown';

export type TaggedError = Error & { uploadPhase?: UploadPhase; httpStatus?: number };

export function tagPhase(error: unknown, phase: UploadPhase): never {
  if (error instanceof Error) {
    (error as TaggedError).uploadPhase = phase;
    throw error;
  }
  const wrapped = new Error(String(error ?? 'Upload failed')) as TaggedError;
  wrapped.uploadPhase = phase;
  throw wrapped;
}

export function phaseError(phase: UploadPhase, message: string, httpStatus?: number): never {
  const err = new Error(message) as TaggedError;
  err.uploadPhase = phase;
  if (httpStatus !== undefined) err.httpStatus = httpStatus;
  throw err;
}

export function getUploadPhase(error: unknown): UploadPhase {
  if (error instanceof Error && (error as TaggedError).uploadPhase) {
    return (error as TaggedError).uploadPhase!;
  }
  return 'unknown';
}

export function getUploadHttpStatus(error: unknown): number | undefined {
  if (error instanceof Error) return (error as TaggedError).httpStatus;
  return undefined;
}

/**
 * The R2 PUT routinely loses its TCP socket — or fails to resolve the R2
 * hostname at all — on Android when the device transitions networks
 * (Wi-Fi ↔ cellular), the OS reaps backgrounded sockets, or the DHCP lease
 * rolls over and DNS hasn't recovered yet. Two real fingerprints from Sentry:
 *   - "Failed to connect to <host>" (TCP — expo-file-system / native layer)
 *   - "Unable to resolve host …: No address associated with hostname"
 *     (DNS — Android UnknownHostException, Sentry issue 7445949187 on a
 *     Galaxy Tab A7 Lite, Android 14)
 * Both are clean transport-level failures that almost always succeed on a
 * fresh socket. Mirrors the rule-27 single-retry pattern used for `signIn`
 * against AuthRetryableFetchError.
 *
 * A third fingerprint (Teat2 incident, 2026-05-25): okhttp's
 * SocketTimeoutException when the upload PUT stalls mid-body. expo-file-system
 * surfaces it as an Error whose literal message is the single word "timeout"
 * (client_telemetry phase=r2_put, message="timeout", okhttp 4.12.0). This is a
 * transport-level socket death like the others and succeeds on a fresh socket,
 * so it must auto-retry. Matched via `\btimeout\b` / `SocketTimeout` — NOT the
 * two-word "timed out", which is the withTimeout hard-cap message (now
 * size-adaptive, see `uploadTimeoutMs`) and deliberately fails fast instead of
 * retrying up to 3 × the cap.
 *
 * Match list intentionally narrow: only signatures that come from the
 * expo-file-system native layer, Android's DNS resolver, okhttp's socket
 * timeout, or Hermes' fetch when the *socket* dies. HTTP-level errors (non-2xx
 * responses) are caught further out by the status-range check and must NOT
 * match here — those are not transient and are routed through
 * isStalePresignError instead.
 */
const TRANSIENT_R2_ERROR_RE = /Failed to connect|Network request failed|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|Unable to resolve host|No address associated with hostname|SocketTimeout|\btimeout\b/i;

export function isTransientUploadError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return TRANSIENT_R2_ERROR_RE.test(err.message ?? '');
}

/**
 * Adaptive R2 PUT timeout. The old fixed 10-min cap was too short for large
 * files on slow mobile links — 250 MB needs ~400 KB/s sustained to finish in
 * 10 min, which a congested/unknown link won't hit (Sentry REACT-NATIVE-N,
 * 2026-06-02: iPad, network_state unknown, hit the cap and surfaced
 * "Upload timed out" with no retry). Scale the cap by file size against a
 * conservative throughput floor, clamped so small files keep the proven 10-min
 * budget and huge files never block the UI past 30 min. This only widens the
 * hard cap — the two-word "timed out" rejection still fails fast (it is
 * excluded from TRANSIENT_R2_ERROR_RE on purpose).
 */
export const UPLOAD_TIMEOUT_MIN_MS = 600_000; // 10 min floor (unchanged for small files)
export const UPLOAD_TIMEOUT_MAX_MS = 1_800_000; // 30 min ceiling
const UPLOAD_TIMEOUT_BASE_MS = 60_000; // connection/setup overhead
const UPLOAD_THROUGHPUT_FLOOR_BPS = 50 * 1024; // 50 KB/s worst-case sustained

export function uploadTimeoutMs(fileSizeBytes: number, parallelism = 1): number {
  const size = Number.isFinite(fileSizeBytes) && fileSizeBytes > 0 ? fileSizeBytes : 0;
  // Concurrent PUTs share the link, so each lane's worst-case sustained
  // throughput shrinks proportionally. Only createWithSegments passes > 1;
  // single-file uploads keep the original budget.
  const lanes = Number.isFinite(parallelism) && parallelism > 1 ? parallelism : 1;
  const budget = UPLOAD_TIMEOUT_BASE_MS + Math.ceil(size / (UPLOAD_THROUGHPUT_FLOOR_BPS / lanes)) * 1000;
  return Math.min(UPLOAD_TIMEOUT_MAX_MS, Math.max(UPLOAD_TIMEOUT_MIN_MS, budget));
}

/**
 * Run `total` indexed tasks with at most `concurrency` in flight.
 * Abort-on-first-failure: no NEW tasks start after a failure; in-flight tasks
 * settle on their own (each upload already bounds itself via timeout +
 * cancelAsync), and the first error is rethrown with its identity — and
 * phase tag — intact. Workers themselves never reject, so a mid-pool failure
 * can't leave an unhandled rejection (CLAUDE.md rule 4).
 */
export async function runWithConcurrency(
  total: number,
  concurrency: number,
  task: (index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(total) || total <= 0) return;
  let next = 0;
  let aborted = false;
  let hasError = false;
  let firstError: unknown;

  const worker = async (): Promise<void> => {
    while (!aborted) {
      const i = next++;
      if (i >= total) return;
      try {
        await task(i);
      } catch (err) {
        if (!hasError) {
          hasError = true;
          firstError = err;
        }
        aborted = true;
        return;
      }
    }
  };

  const workerCount = Math.max(1, Math.min(concurrency, total));
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) workers.push(worker());
  await Promise.all(workers);
  if (hasError) throw firstError;
}

/**
 * Stale-presigned-URL detector. R2 returns 403 (sig mismatch / expired) or
 * 401 when the presigned URL the client cached is no longer accepted —
 * typically because device clock drifted, the URL expired between presign and
 * PUT, or the upload pipeline retried with a URL that R2 has since rotated.
 * Re-presigning once and retrying recovers most of these. Tracked as Sentry
 * REACT-NATIVE-7 (HTTP 403 fingerprint, 8 events / 2 users over 6 days).
 *
 * Cap to a single re-presign in the retry loop — a genuine auth failure
 * (bad sigv4, deleted bucket, IAM policy change) will surface as the same
 * 401/403 on the second presign too and we want that to terminate, not loop.
 */
export function isStalePresignError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as TaggedError).httpStatus;
  return status === 401 || status === 403;
}
