import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 2,
      staleTime: 5 * 60 * 1000, // 5 minutes — prevents redundant refetches during normal use
      // Minimize PHI retention in memory: garbage-collect cached data
      // 60 seconds after the last observer unmounts
      gcTime: 60000,
    },
  },
});
