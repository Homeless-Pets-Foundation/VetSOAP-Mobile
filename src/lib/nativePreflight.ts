import { UPLOAD_PREFLIGHT_TIMEOUT_COPY } from '../constants/strings';
import { withPromiseTimeout } from './promiseTimeout';

export const NATIVE_PREFLIGHT_TIMEOUT_MS = 10_000;
export const NATIVE_PREFLIGHT_TIMEOUT_CODE = 'NATIVE_PREFLIGHT_TIMEOUT' as const;

export const NATIVE_PREFLIGHT_OPERATIONS = [
  'durable_manifest',
  'source_metadata',
  'segment_metadata',
  'silence_metadata',
  'split_input_metadata',
  'split_output_metadata',
  'api_metadata',
] as const;

export type NativePreflightOperation =
  (typeof NATIVE_PREFLIGHT_OPERATIONS)[number];
export type NativePreflightMode = 'durable' | 'standard';

const NATIVE_PREFLIGHT_MODES = ['durable', 'standard'] as const;

function isNativePreflightOperation(
  value: unknown,
): value is NativePreflightOperation {
  return (
    typeof value === 'string' &&
    (NATIVE_PREFLIGHT_OPERATIONS as readonly string[]).includes(value)
  );
}

function isNativePreflightMode(value: unknown): value is NativePreflightMode {
  return (
    typeof value === 'string' &&
    (NATIVE_PREFLIGHT_MODES as readonly string[]).includes(value)
  );
}

function clampFileCount(value: number): number {
  const integer = Number.isFinite(value) ? Math.trunc(value) : 1;
  return Math.min(20, Math.max(1, integer));
}

export class NativePreflightTimeoutError extends Error {
  readonly code = NATIVE_PREFLIGHT_TIMEOUT_CODE;
  readonly uploadPhase = 'preflight' as const;
  readonly operation: NativePreflightOperation;
  readonly mode: NativePreflightMode;
  readonly fileCount: number;

  constructor(
    operation: NativePreflightOperation,
    mode: NativePreflightMode,
    fileCount: number,
  ) {
    super(UPLOAD_PREFLIGHT_TIMEOUT_COPY[mode]);
    this.name = 'NativePreflightTimeoutError';
    this.operation = operation;
    this.mode = mode;
    this.fileCount = clampFileCount(fileCount);
  }
}

export type NativePreflightTimeout = Error & {
  code: typeof NATIVE_PREFLIGHT_TIMEOUT_CODE;
  uploadPhase?: 'preflight';
  operation: NativePreflightOperation;
  mode: NativePreflightMode;
  fileCount: number;
};

/**
 * Stable-code detection deliberately does not depend on `instanceof`: errors
 * may cross a VM/native boundary. Validate every diagnostic dimension before
 * a caller is allowed to forward it to monitoring.
 */
export function isNativePreflightTimeout(
  error: unknown,
): error is NativePreflightTimeout {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    code?: unknown;
    operation?: unknown;
    mode?: unknown;
    fileCount?: unknown;
  };
  return (
    candidate.code === NATIVE_PREFLIGHT_TIMEOUT_CODE &&
    isNativePreflightOperation(candidate.operation) &&
    isNativePreflightMode(candidate.mode) &&
    typeof candidate.fileCount === 'number' &&
    Number.isInteger(candidate.fileCount) &&
    candidate.fileCount >= 1 &&
    candidate.fileCount <= 20
  );
}

let nextDevelopmentHang: NativePreflightOperation | null = null;

/**
 * One-shot development diagnostic. The `__DEV__` branch is removed from
 * release bundles, and no build-time flag can re-arm it after a restart.
 */
export function armNativePreflightHang(
  operation: NativePreflightOperation,
): boolean {
  if (!__DEV__ || !isNativePreflightOperation(operation)) return false;
  nextDevelopmentHang = operation;
  return true;
}

export function clearNativePreflightHang(): void {
  nextDevelopmentHang = null;
}

export function getArmedNativePreflightHang():
  | NativePreflightOperation
  | null {
  return __DEV__ ? nextDevelopmentHang : null;
}

function consumeDevelopmentHang(
  operation: NativePreflightOperation,
): boolean {
  if (!__DEV__ || nextDevelopmentHang !== operation) return false;
  nextDevelopmentHang = null;
  return true;
}

export interface NativePreflightBatch {
  readonly mode: NativePreflightMode;
  readonly fileCount: number;
  readonly deadlineMs: number;
  read<T>(
    operation: NativePreflightOperation,
    factory: () => Promise<T>,
  ): Promise<T>;
}

interface NativePreflightBatchOptions {
  timeoutMs?: number;
  now?: () => number;
}

/**
 * Create one absolute deadline shared by every sequential read in a coherent
 * batch. An expired budget rejects before invoking the next native factory.
 */
export function createNativePreflightBatch(
  mode: NativePreflightMode,
  fileCount: number,
  options: NativePreflightBatchOptions = {},
): NativePreflightBatch {
  const now = options.now ?? Date.now;
  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
      ? Math.max(0, options.timeoutMs)
      : NATIVE_PREFLIGHT_TIMEOUT_MS;
  const normalizedCount = clampFileCount(fileCount);
  const deadlineMs = now() + timeoutMs;

  return {
    mode,
    fileCount: normalizedCount,
    deadlineMs,
    async read<T>(
      operation: NativePreflightOperation,
      factory: () => Promise<T>,
    ): Promise<T> {
      const timeoutError = () =>
        new NativePreflightTimeoutError(operation, mode, normalizedCount);
      const remainingMs = deadlineMs - now();
      if (remainingMs <= 0) throw timeoutError();

      let source: Promise<T>;
      if (consumeDevelopmentHang(operation)) {
        source = new Promise<T>(() => {});
      } else {
        // Invoke only after the remaining-budget check. A synchronous native
        // bridge throw stays the original error and is not relabeled.
        source = factory();
      }

      // Timer delivery is not guaranteed while React Native is suspended.
      // Re-check wall time on either source settlement so an overdue result
      // cannot resume the caller and begin network work before the timer runs.
      const deadlineChecked = Promise.resolve(source).then(
        (value) => {
          if (now() >= deadlineMs) throw timeoutError();
          return value;
        },
        (error) => {
          if (now() >= deadlineMs) throw timeoutError();
          throw error;
        },
      );

      return withPromiseTimeout(
        deadlineChecked,
        remainingMs,
        UPLOAD_PREFLIGHT_TIMEOUT_COPY[mode],
        timeoutError,
      );
    },
  };
}
