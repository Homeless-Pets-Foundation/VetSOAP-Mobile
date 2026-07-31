import { UPLOAD_PREFLIGHT_TIMEOUT_COPY } from '../constants/strings';
import {
  isNativePreflightTimeout,
  type NativePreflightMode,
} from './nativePreflight';

interface WarningContext {
  tags: {
    operation: string;
    mode: string;
    file_count: string;
  };
}

type CaptureWarning = (
  message: string,
  level: 'warning',
  context: WarningContext,
) => void;

export interface NativePreflightTimeoutPresentation {
  mode: NativePreflightMode;
  copy: string;
}

/**
 * Privacy-minimal, dedicated timeout reporting. The closed input validator
 * prevents a server error reusing the code from injecting telemetry values.
 */
export function presentNativePreflightTimeout(
  error: unknown,
  captureWarning: CaptureWarning,
): NativePreflightTimeoutPresentation | null {
  if (!isNativePreflightTimeout(error)) return null;
  try {
    captureWarning(
      `NATIVE_PREFLIGHT_TIMEOUT:${error.operation}:${error.mode}`,
      'warning',
      {
        tags: {
          operation: error.operation,
          mode: error.mode,
          file_count: String(error.fileCount),
        },
      },
    );
  } catch {
    // Monitoring must never interfere with releasing the upload attempt.
  }
  return {
    mode: error.mode,
    copy: UPLOAD_PREFLIGHT_TIMEOUT_COPY[error.mode],
  };
}
