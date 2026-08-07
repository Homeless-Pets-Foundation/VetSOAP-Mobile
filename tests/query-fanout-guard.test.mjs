/**
 * Guards the request-fan-out half of the latency fix.
 *
 * Production Sentry breadcrumbs from clinic tablets showed up to four
 * concurrent `GET /api/recordings` (distinct request ids) plus
 * `/api/organization/dashboard` twice ~8s apart in a single foreground resume,
 * every one of them HTTP 200 and 12-21s on the wire, while a tiny
 * `POST /api/device-sessions/register` in the SAME window returned in 1.6s and
 * the server's own p95 for those routes is under 600ms. The cost was the
 * number of simultaneous requests, not the server.
 *
 * Three structural rules keep it from coming back:
 *   1. Every list/dashboard queryFn forwards React Query's AbortSignal, so a
 *      superseding refetch cancels instead of stacking (`cancelRefetch: true`
 *      is the default and can only abort a signal the queryFn consumed).
 *   2. Refreshes triggered by focus / foreground are stale-gated, so a cache
 *      window actually means something.
 *   3. Nothing polls an endpoint on behalf of UI that is not showing.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (file) => readFile(path.join(root, file), 'utf8');

test('apiClient.get and recordingsApi.list accept and forward an AbortSignal', async () => {
  const client = await read('src/api/client.ts');
  const recordings = await read('src/api/recordings.ts');

  assert.match(
    client,
    /get<T>\(\s*path: string,\s*params\?: Record<string, string \| number \| undefined>,\s*options\?: \{ signal\?: AbortSignal \},\s*\) \{\s*return this\.request<T>\(path, \{ params, signal: options\?\.signal \}\);/
  );

  // `signal` is a transport concern and must never reach the query string.
  assert.match(recordings, /signal\?: AbortSignal;/);
  assert.match(recordings, /const \{ signal, \.\.\.queryParams \} = params;/);
  assert.match(recordings, /const sanitized = \{ \.\.\.queryParams \}/);
  assert.match(recordings, /apiClient\.get\('\/api\/recordings', sanitized, \{ signal \}\)/);
  // The submittedAt->createdAt compatibility retry must carry it too.
  assert.match(recordings, /\{ \.\.\.sanitized, sortBy: 'createdAt' \}, \{ signal \}/);
});

test('every /api/recordings query forwards the signal', async () => {
  const home = await read('app/(app)/(tabs)/index.tsx');
  const records = await read('app/(app)/(tabs)/recordings/index.tsx');
  const attention = await read('src/hooks/useAttentionFeed.ts');

  // Home: recent + recent drafts.
  assert.match(home, /queryKey: \['recordings', 'recent'\],\s*\n\s*queryFn: \(\{ signal \}: \{ signal: AbortSignal \}\) =>/);
  assert.match(home, /queryKey: \['recordings', 'drafts', 'recent'\],\s*\n\s*queryFn: \(\{ signal \}: \{ signal: AbortSignal \}\) =>/);

  // Records tab: the infinite list and the drafts list.
  assert.match(records, /queryFn: \(\{ pageParam = 1, signal \}\) =>\s*\n\s*recordingsApi\.list\(\{\s*\n\s*signal,/);
  assert.match(records, /queryFn: \(\{ signal \}\) =>\s*\n\s*recordingsApi\.list\(\{\s*\n\s*signal,/);

  // Attention feed: the single largest response the app requests.
  assert.match(attention, /queryFn: \(\{ signal \}\) => fetchAttentionPage\(signal\)/);

  // A queryFn taking no arguments cannot consume the signal.
  assert.doesNotMatch(home, /queryFn: \(\) => recordingsApi\.list\(/);
  assert.doesNotMatch(records, /queryFn: \(\) => recordingsApi\.list\(/);
});

test('the quality dashboard query forwards the signal', async () => {
  const home = await read('app/(app)/(tabs)/index.tsx');
  const api = await read('src/api/qualityAnalytics.ts');

  assert.match(
    home,
    /queryFn: \(\{ signal \}\) => qualityAnalyticsApi\.getDashboardQuality\(\{ signal \}\)/
  );
  assert.match(
    api,
    /async getDashboardQuality\(options: \{ signal\?: AbortSignal \} = \{\}\)/
  );
  assert.match(api, /\{ signal: options\.signal \}/);
});

test('the attention feed no longer refetches 100 rows unconditionally', async () => {
  const attention = await read('src/hooks/useAttentionFeed.ts');

  // `refetchOnMount: 'always'` re-downloaded the whole page on every mount of
  // either surface regardless of cache age.
  assert.doesNotMatch(attention, /refetchOnMount: 'always'/);
  // The foreground-resume refetch is stale-gated, matching the focus effect.
  assert.match(attention, /const serverIsStaleRef = useRef\(serverQuery\.isStale\);/);
  assert.match(
    attention,
    /if \(canLoadServerData && serverIsStaleRef\.current\) serverRefetch\(\)\.catch\(\(\) => \{\}\);/
  );
  // The local source has no invalidation channel and costs no network, so it
  // deliberately stays unconditional.
  assert.match(attention, /if \(user\?\.id\) localRefetch\(\)\.catch\(\(\) => \{\}\);/);
  // The page size is a coverage contract, not a tuning knob — frequency was
  // reduced, size was not.
  assert.match(attention, /limit: ATTENTION_PAGE_LIMIT/);
});

test('the provider-issue banner honours its own staleTime', async () => {
  const banner = await read('src/components/ProviderIssueBanner.tsx');

  assert.match(banner, /staleTime: 60_000/);
  assert.match(banner, /const isStaleRef = useRef\(isStale\);/);
  assert.match(banner, /if \(canView && isStaleRef\.current\) refetch\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(
    banner,
    /if \(nextState === 'active' && canView && isStaleRef\.current\) \{\s*refetch\(\)\.catch\(\(\) => \{\}\);/
  );
});

test('device-sessions is not polled on behalf of a hidden modal', async () => {
  const hook = await read('src/hooks/useDeviceCapacity.ts');
  const modal = await read('src/components/DeviceLimitModal.tsx');

  assert.match(hook, /enabled\?: boolean;/);
  assert.match(hook, /const callerEnabled = options\.enabled \?\? true;/);
  assert.match(hook, /callerEnabled && !!user && !deviceRegistrationBlock && !deviceRegistrationPending/);
  // The poll and the focus refetch must be gated by the same flag as `enabled`;
  // otherwise a disabled query still schedules work.
  assert.match(
    hook,
    /refetchInterval: canQueryDeviceSessions && mode === 'manage' && isTabFocused \? 60_000 : false/
  );
  assert.match(hook, /refetchOnWindowFocus: canQueryDeviceSessions && mode === 'manage'/);

  // The modal is mounted at the app root for the whole session lifetime.
  assert.match(
    modal,
    /useDeviceCapacity\(\{\s*mode: 'manage',\s*enabled: !!deviceRegistrationBlock,\s*\}\)/
  );
});

test('the quality dashboard refetch requires a real completion and is throttled', async () => {
  const home = await read('app/(app)/(tabs)/index.tsx');

  assert.match(home, /const QUALITY_REFETCH_MIN_INTERVAL_MS = 30_000;/);
  assert.match(home, /const visibleRecordingIds = useMemo\(/);
  // Still visible AND no longer processing == genuinely terminal. Merely
  // absent means it fell out of the top-5 window.
  assert.match(home, /visibleRecordingIds\.has\(id\) && !processingRecordingIds\.has\(id\)/);
  assert.match(home, /sinceLast >= QUALITY_REFETCH_MIN_INTERVAL_MS/);
  assert.doesNotMatch(home, /const completedProcessing = /);
  // Throttled, not dropped — a completion inside the window arms one trailing
  // refetch rather than being forgotten.
  assert.match(home, /trailingQualityRefetchRef\.current = setTimeout\(/);
  assert.match(home, /clearTimeout\(trailingQualityRefetchRef\.current\)/);
});
