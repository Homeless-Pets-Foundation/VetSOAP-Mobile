import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Skip retries on 429 — the rate-limit window hasn't rolled yet, so
      // retrying just burns more budget and keeps the counter pinned.
      // Also skip retries on 401/403/404 — those won't succeed on retry.
      retry: (failureCount, error) => {
        if (error instanceof ApiError) {
          if (error.status === 429 || error.status === 401 || error.status === 403 || error.status === 404) {
            return false;
          }
        }
        return failureCount < 2;
      },
      staleTime: 5 * 60 * 1000, // 5 minutes — prevents redundant refetches during normal use
      // Minimize PHI retention in memory: garbage-collect cached data
      // 60 seconds after the last observer unmounts
      gcTime: 60000,
    },
  },
});
