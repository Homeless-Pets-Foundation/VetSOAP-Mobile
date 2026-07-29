import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { recordingsApi } from '../api/recordings';
import {
  ATTENTION_PAGE_LIMIT,
  ATTENTION_PAGE_NUMBER,
  attentionCoverage,
  buildLocalAttentionItems,
  compareAttentionItems,
  deriveRecordingAttention,
  groupAttentionItems,
  hasPendingTimingBoundary,
  hasPollableAttentionRow,
  isUnsentWorkSummaryKnown,
  parseAttentionEnvelope,
  topReasonCode,
  type AttentionCoverage,
  type AttentionEnvelope,
  type AttentionFeedItem,
  type AttentionGroups,
} from '../lib/attentionFeed';
import { ATTENTION_QUERY_KEY } from '../lib/recordingQueryCache';
import { getUnsentWorkSummary, type UnsentWorkSummary } from '../lib/localRecordings';
import { trackEvent, type AttentionServerState, type AttentionSurface } from '../lib/analytics';
import { useAuthDeviceRegistration, useAuthUser } from './useAuth';

/**
 * Composes ONE bounded server page with a user-scoped local-work read.
 *
 * Server error / stale / truncation / classification state is exposed
 * SEPARATELY from items so a failed request is never rendered as a falsely
 * clean feed, and `data === undefined` is never translated into "all clear".
 */

/** Never poll faster than once a minute, and only while something can change. */
export const ATTENTION_POLL_INTERVAL_MS = 60_000;
/** Local clock tick that crosses 5/20/35-minute and 7-day boundaries. */
export const ATTENTION_TICK_INTERVAL_MS = 60_000;
const LOCAL_UNSENT_STALE_MS = 30_000;

export const ATTENTION_LOCAL_QUERY_ROOT = 'attention';
export const ATTENTION_LOCAL_QUERY_SUB = 'local-unsent';

export function attentionLocalQueryKey(userId: string | null | undefined): unknown[] {
  return [ATTENTION_LOCAL_QUERY_ROOT, ATTENTION_LOCAL_QUERY_SUB, userId ?? 'anonymous'];
}

/**
 * `disabled`/`loading` never settle into an impression or a clean state.
 * `blocked` is a REAL device-registration block, not transient pending.
 */
export type AttentionServerPhase =
  | 'disabled'
  | 'loading'
  | 'blocked'
  | 'error'
  | 'stale_error'
  | 'partial'
  | 'success';

export interface UseAttentionFeedResult {
  items: AttentionFeedItem[];
  groups: AttentionGroups;
  serverItems: AttentionFeedItem[];
  localItems: AttentionFeedItem[];
  serverPhase: AttentionServerPhase;
  /** Settled snapshot state for analytics; `null` while loading/disabled. */
  serverState: AttentionServerState | null;
  isSettled: boolean;
  coverage: AttentionCoverage;
  isTruncated: boolean;
  /** `M` — how many recently updated practice recordings were actually checked. */
  checkedCount: number;
  classificationComplete: boolean;
  uncheckableTimingRowCount: number;
  localSummary: UnsentWorkSummary | null;
  localComplete: boolean;
  /** The local read has produced a result (known or explicitly unknown). */
  localSettled: boolean;
  /** The ONE positive claim, and it is feed-scoped (see the plan's table). */
  isClean: boolean;
  isLoading: boolean;
  isRefreshing: boolean;
  refresh: () => void;
  /** PHI-free snapshot identity for impression dedupe. Never emitted. */
  fingerprint: string;
}

async function fetchAttentionPage(): Promise<AttentionEnvelope> {
  const response = await recordingsApi.list({
    page: ATTENTION_PAGE_NUMBER,
    limit: ATTENTION_PAGE_LIMIT,
    // Attention is about recently CHANGED source state. `submittedAt` would
    // null-sort prepared `uploading` rows to the end and hide the very
    // abandoned-upload signal this feed claims to detect.
    sortBy: 'updatedAt',
    sortOrder: 'desc',
  });
  return parseAttentionEnvelope(response, {
    page: ATTENTION_PAGE_NUMBER,
    limit: ATTENTION_PAGE_LIMIT,
  });
}

const EMPTY_ROWS: AttentionEnvelope['data'] = [];

export function useAttentionFeed(options: { focused: boolean }): UseAttentionFeedResult {
  const { focused } = options;
  const user = useAuthUser();
  const { deviceRegistrationPending, deviceRegistrationBlock } = useAuthDeviceRegistration();
  const recordFirstEnabled = user?.capabilities?.includes('record_first') ?? false;

  const [isAppActive, setIsAppActive] = useState(AppState.currentState === 'active');
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Gate on the SAME device-registration readiness as other server data, but
  // keep WHY it is disabled visible: transient pending is loading, a real
  // block is a settled `blocked` state.
  const canLoadServerData = !!user && !deviceRegistrationPending && !deviceRegistrationBlock;

  const serverQuery = useQuery({
    queryKey: [...ATTENTION_QUERY_KEY],
    queryFn: fetchAttentionPage,
    enabled: canLoadServerData,
    // Deliberately NOT PERSIST_GC_TIME_MS: this page is excluded from disk
    // dehydration, so a long gcTime would only pin a stale in-memory queue.
    refetchOnMount: 'always',
    refetchInterval: (query) => {
      if (!focused || !isAppActive) return false;
      const rows = query.state.data?.data;
      return hasPollableAttentionRow(rows) ? ATTENTION_POLL_INTERVAL_MS : false;
    },
  });

  const localQuery = useQuery({
    queryKey: attentionLocalQueryKey(user?.id),
    queryFn: () => getUnsentWorkSummary(user?.id ?? ''),
    enabled: !!user?.id,
    staleTime: LOCAL_UNSENT_STALE_MS,
  });

  const rows = serverQuery.data?.data ?? EMPTY_ROWS;
  // React Query keeps `refetch` referentially stable; alias it so no effect or
  // callback depends on the whole (per-render) query object.
  const serverRefetch = serverQuery.refetch;
  const localRefetch = localQuery.refetch;

  // Foreground resume: update the clock immediately and refresh both sources.
  // Synchronous handler with an outer try/catch; every Promise is observed.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      try {
        const active = nextState === 'active';
        setIsAppActive(active);
        if (!active) return;
        setNowMs(Date.now());
        if (!focused) return;
        if (canLoadServerData) serverRefetch().catch(() => {});
        if (user?.id) localRefetch().catch(() => {});
      } catch {
        // A listener throw would take down the AppState subscription.
      }
    });
    return () => subscription.remove();
  }, [canLoadServerData, focused, user?.id, localRefetch, serverRefetch]);

  // Minute tick — crosses the 5/20/35-minute stale thresholds, a parseable
  // future timestamp becoming current, and the 7-day quality expiry WITHOUT a
  // network request. Runs only while focused/active and only while a row can
  // still cross a boundary; stops in the background.
  const tickNeeded = focused && isAppActive && hasPendingTimingBoundary(rows, nowMs);
  useEffect(() => {
    if (!tickNeeded) return;
    const timer = setInterval(() => setNowMs(Date.now()), ATTENTION_TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [tickNeeded]);

  const derivation = useMemo(
    () => deriveRecordingAttention(rows, user, { nowMs, recordFirstEnabled }),
    [rows, user, nowMs, recordFirstEnabled]
  );

  const localSummary = localQuery.data ?? null;
  const localComplete = isUnsentWorkSummaryKnown(localSummary);
  const localItems = useMemo(
    () => buildLocalAttentionItems(localSummary, user),
    [localSummary, user]
  );

  const envelope = serverQuery.data ?? null;
  const coverage = attentionCoverage(envelope);
  const checkedCount = envelope?.data.length ?? 0;

  const serverPhase: AttentionServerPhase = useMemo(() => {
    if (!user) return 'disabled';
    if (deviceRegistrationBlock) return 'blocked';
    if (deviceRegistrationPending) return 'disabled';
    if (serverQuery.isError) return serverQuery.data ? 'stale_error' : 'error';
    if (!serverQuery.data) return 'loading';
    return derivation.classificationComplete ? 'success' : 'partial';
  }, [
    user,
    deviceRegistrationBlock,
    deviceRegistrationPending,
    serverQuery.isError,
    serverQuery.data,
    derivation.classificationComplete,
  ]);

  const isSettled =
    serverPhase === 'blocked' ||
    serverPhase === 'error' ||
    serverPhase === 'stale_error' ||
    serverPhase === 'partial' ||
    serverPhase === 'success';
  const serverState: AttentionServerState | null = isSettled
    ? (serverPhase as AttentionServerState)
    : null;

  const items = useMemo(
    () => [...derivation.items, ...localItems].sort(compareAttentionItems),
    [derivation.items, localItems]
  );
  const groups = useMemo(() => groupAttentionItems(items), [items]);

  // The positive clean claim requires ALL SIX conditions. Every other
  // zero-row combination is qualified copy (see ATTENTION_FEED_COPY).
  const isClean =
    serverPhase === 'success' &&
    coverage === 'complete' &&
    derivation.classificationComplete &&
    derivation.items.length === 0 &&
    localComplete &&
    (localSummary?.draftCount ?? 0) === 0 &&
    (localSummary?.stashSessionCount ?? 0) === 0;

  const fingerprint = useMemo(() => {
    const rowsPart = items
      .map(
        (item) =>
          `${item.key}|${item.reasons.map((reason) => `${reason.code}:${reason.field ?? ''}`).join('+')}|${item.actionable ? 1 : 0}`
      )
      .join(';');
    return [
      rowsPart,
      coverage,
      serverPhase,
      derivation.classificationComplete ? 1 : 0,
      derivation.uncheckableTimingRowCount,
      localComplete ? 1 : 0,
      localSummary?.draftCount ?? -1,
      localSummary?.stashSessionCount ?? -1,
    ].join('~');
  }, [
    items,
    coverage,
    serverPhase,
    derivation.classificationComplete,
    derivation.uncheckableTimingRowCount,
    localComplete,
    localSummary?.draftCount,
    localSummary?.stashSessionCount,
  ]);

  const refresh = useCallback(() => {
    // Void wrapper around a bounded, observed refresh — pull-to-refresh may
    // never hand React Native a Promise (rule 2/4). `refetch()` is the FORCE:
    // stash mutations never invalidate React Query, so a staleTime alone would
    // keep showing yesterday's saved-session count.
    const tasks: Promise<unknown>[] = [];
    if (canLoadServerData) tasks.push(serverRefetch());
    if (user?.id) tasks.push(localRefetch());
    Promise.allSettled(tasks).catch(() => {});
  }, [canLoadServerData, localRefetch, serverRefetch, user?.id]);

  // Focused-screen mount + focus changes refresh the LOCAL source explicitly:
  // stash writes never invalidate React Query, so a staleTime alone would show
  // yesterday's saved-session count. A stale server page refreshes with it, so
  // returning from a detail fix does not leave the row on screen.
  const serverIsStale = serverQuery.isStale;
  useEffect(() => {
    if (!focused) return;
    if (user?.id) localRefetch().catch(() => {});
    if (canLoadServerData && serverIsStale) serverRefetch().catch(() => {});
  }, [focused, user?.id, canLoadServerData, serverIsStale, localRefetch, serverRefetch]);

  return {
    items,
    groups,
    serverItems: derivation.items,
    localItems,
    serverPhase,
    serverState,
    isSettled,
    coverage,
    isTruncated: coverage === 'recent_page_only',
    checkedCount,
    classificationComplete: derivation.classificationComplete,
    uncheckableTimingRowCount: derivation.uncheckableTimingRowCount,
    localSummary,
    localComplete,
    localSettled: localSummary !== null,
    isClean,
    isLoading: serverQuery.isLoading || localQuery.isLoading,
    isRefreshing: serverQuery.isRefetching || localQuery.isRefetching,
    refresh,
    fingerprint,
  };
}

/**
 * Emit `attention_feed_shown` once per surface focus AND per stable PHI-free
 * snapshot fingerprint. A real partial/error transition or a local count change
 * produces a new settled snapshot; ordinary rerenders and a minute tick with no
 * classification change do not inflate impressions.
 *
 * Every prop is constructed EXPLICITLY from bounded enums/counts — never by
 * spreading a feed item.
 */
export function useAttentionImpression(
  surface: AttentionSurface,
  feed: UseAttentionFeedResult,
  focused: boolean
): void {
  const lastFingerprintRef = useRef<string | null>(null);

  useEffect(() => {
    if (!focused) {
      // Re-arm on blur so the next focus emits a fresh impression.
      lastFingerprintRef.current = null;
      return;
    }
    if (!feed.isSettled || !feed.serverState) return;
    if (lastFingerprintRef.current === feed.fingerprint) return;
    lastFingerprintRef.current = feed.fingerprint;

    trackEvent({
      name: 'attention_feed_shown',
      props: {
        surface,
        item_count: feed.items.length,
        server_item_count: feed.serverItems.length,
        local_item_count: feed.localItems.length,
        actionable_count: feed.groups.needsYou.length,
        across_practice_count: feed.groups.acrossPractice.length,
        top_reason_code: topReasonCode(feed.items),
        coverage: feed.coverage,
        truncated: feed.isTruncated,
        server_state: feed.serverState,
        // A blocked/error snapshot reports false with a zero timing count:
        // "none observed", not proof of completeness.
        classification_complete:
          feed.serverPhase === 'success' ? feed.classificationComplete : false,
        uncheckable_timing_row_count: feed.uncheckableTimingRowCount,
        local_complete: feed.localComplete,
      },
    });
  }, [
    focused,
    surface,
    feed.isSettled,
    feed.serverState,
    feed.fingerprint,
    feed.items,
    feed.serverItems.length,
    feed.localItems.length,
    feed.groups.needsYou.length,
    feed.groups.acrossPractice.length,
    feed.coverage,
    feed.isTruncated,
    feed.serverPhase,
    feed.classificationComplete,
    feed.uncheckableTimingRowCount,
    feed.localComplete,
  ]);
}
