import { AppState } from 'react-native';
import { focusManager, QueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';

// React Query's default focus listener needs `window` events, which React
// Native does not have, so `focusManager.isFocused()` was always true: every
// `refetchInterval` kept polling while the app sat in the background and its
// requests landed in the foreground's network budget on resume. AppState is
// the native equivalent. Only polling (and retry back-off) follows it —
// `refetchOnWindowFocus` stays off below because the screens already refresh
// stale data on foreground themselves, and a second, library-driven refresh
// of every active query on each resume would be its own request burst.
// onlineManager is deliberately left alone: tying it to NetInfo would pause
// mutations while offline, which the upload and draft flows do not expect.
focusManager.setEventListener((handleFocus) => {
  const subscription = AppState.addEventListener('change', (state) => {
    handleFocus(state === 'active');
  });
  return () => subscription.remove();
});

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
      // Keep cache ≥ staleTime so returning to an unmounted tab renders
      // instantly from cache instead of cold-fetching with a spinner.
      // Cross-user PHI isolation does not depend on this: queryClient.clear()
      // runs on every sign-out path in AuthProvider, so this only bounds
      // same-user in-memory retention after the last observer unmounts.
      gcTime: 10 * 60 * 1000,
      refetchOnWindowFocus: false,
    },
  },
});
