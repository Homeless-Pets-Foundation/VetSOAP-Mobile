import { useEffect, useRef } from 'react';
import { ApiError } from '../api/client';
import { breadcrumb, captureMessage } from '../lib/monitoring';

const INITIAL_LOAD_RETRY_DELAY_MS = 2500;

interface RetryableInitialLoadErrorOptions {
  screen: 'home' | 'records';
  source: 'recordings' | 'drafts';
  retryKey: string;
  enabled: boolean;
  isError: boolean;
  error: unknown;
  hasData: boolean;
  refetch: () => Promise<unknown>;
}

function errorInfo(error: unknown): {
  name: string;
  status: string;
  code: string;
  retryable: boolean;
} {
  if (error instanceof ApiError) {
    return {
      name: error.name || 'ApiError',
      status: String(error.status),
      code: error.code ?? 'none',
      retryable: error.isRetryable || error.status === 408 || error.status === 428 || error.status >= 500,
    };
  }

  const name =
    error && typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string'
      ? (error as { name: string }).name
      : 'Error';

  // Non-ApiError failures here are usually fetch/native bridge failures
  // without an HTTP response. Retry once, then leave the visible Retry action.
  return {
    name,
    status: 'no_response',
    code: 'none',
    retryable: true,
  };
}

export function useRetryableInitialLoadError({
  screen,
  source,
  retryKey,
  enabled,
  isError,
  error,
  hasData,
  refetch,
}: RetryableInitialLoadErrorOptions): void {
  const observedKeysRef = useRef<Set<string>>(new Set());
  const retriedKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled || !isError || hasData) return;

    const info = errorInfo(error);
    const eventKey = `${screen}:${source}:${retryKey}:${info.status}:${info.code}:${info.name}`;

    if (!observedKeysRef.current.has(eventKey)) {
      observedKeysRef.current.add(eventKey);
      captureMessage('initial_list_load_failed', 'warning', {
        tags: {
          screen,
          source,
          status: info.status,
          code: info.code,
          error_name: info.name,
          retryable: String(info.retryable),
        },
      });
    }

    if (!info.retryable || retriedKeysRef.current.has(eventKey)) return;
    retriedKeysRef.current.add(eventKey);

    breadcrumb('network', 'initial_list_load_retry_scheduled', {
      screen,
      source,
      status: info.status,
      code: info.code,
      delay_ms: INITIAL_LOAD_RETRY_DELAY_MS,
    });

    const timer = setTimeout(() => {
      refetch().catch(() => {});
    }, INITIAL_LOAD_RETRY_DELAY_MS);

    return () => clearTimeout(timer);
  }, [enabled, error, hasData, isError, refetch, retryKey, screen, source]);
}
