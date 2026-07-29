import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { AlertTriangle } from 'lucide-react-native';
import { ATTENTION_FEED_COPY } from '../constants/strings';
import { trackEvent, type AttentionSurface } from '../lib/analytics';
import type { AttentionDestination, AttentionFeedItem } from '../lib/attentionFeed';
import { formatShortDate } from '../lib/recordingDisplay';
import { useThemeColors } from '../hooks/useThemeColors';
import type { UseAttentionFeedResult } from '../hooks/useAttentionFeed';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { ListItem } from './ui/ListItem';
import { HIT_SLOP } from './ui/styles';

/** How many actionable rows Home shows before deferring to the full screen. */
export const HOME_ATTENTION_ROW_LIMIT = 3;

/**
 * Route for a feed destination. `from=attention` drives the detail screen's
 * Back fallback; `focus` is re-validated against an allowlist there and can
 * never bypass a permission gate.
 */
export function attentionDestinationHref(destination: AttentionDestination): string {
  switch (destination.kind) {
    case 'recording_detail':
      return destination.focus
        ? `/recordings/${destination.recordingId}?from=attention&focus=${destination.focus}`
        : `/recordings/${destination.recordingId}?from=attention`;
    case 'recordings_list':
      return '/recordings';
    case 'record_tab':
      return '/record';
    case 'recovery':
      return '/recording-recovery';
    default:
      return '/recordings';
  }
}

function metaLineFor(item: AttentionFeedItem): string {
  const parts: string[] = [];
  if (item.extraIssueCount > 0) parts.push(ATTENTION_FEED_COPY.moreIssues(item.extraIssueCount));
  if (item.warningCount > 1) parts.push(ATTENTION_FEED_COPY.moreWarnings(item.warningCount - 1));
  if (item.ctaLabel) parts.push(item.ctaLabel);
  else parts.push(ATTENTION_FEED_COPY.readOnlyNote);
  return parts.join(' · ');
}

interface AttentionItemRowProps {
  item: AttentionFeedItem;
  surface: AttentionSurface;
}

export function AttentionItemRow({ item, surface }: AttentionItemRowProps) {
  const router = useRouter();

  // A non-navigating row: every candidate screen would reject this viewer, so a
  // tap would dead-end. `ListItem` renders a plain View without `onPress`.
  const isInformational = item.destination.kind === 'informational';

  /**
   * The visit date, falling back to the row's last-updated date for rows that
   * were never submitted (prepared uploads, stuck drafts) — the same precedence
   * the feed already sorts by.
   *
   * Rendered in the `badge` slot, NOT appended to `meta`: `meta` is a single
   * ellipsized line already carrying "+N more issues · CTA".
   *
   * Device-local summary rows carry no timestamps by construction (they stand
   * for a COUNT of drafts/sessions, not one recording), so they get no date
   * rather than a fabricated one.
   */
  const dateLabel = formatShortDate(item.submittedAtMs ?? item.updatedAtMs, Date.now());

  return (
    <ListItem
      title={item.title}
      subtitle={item.body}
      meta={metaLineFor(item)}
      metaClassName={item.actionable ? 'text-brand-500 font-medium' : undefined}
      badge={
        dateLabel ? (
          /* flexShrink:0 — Android under-measures short Text in a flex-row and
             clips the last glyph; the title beside it is the flexible one. */
          <Text
            className="text-caption text-content-tertiary"
            style={{ flexShrink: 0 }}
            numberOfLines={1}
          >
            {dateLabel}
          </Text>
        ) : undefined
      }
      showChevron={!isInformational}
      accessibilityLabel={
        dateLabel ? `${item.accessibilityLabel}. ${dateLabel}` : item.accessibilityLabel
      }
      onPress={
        isInformational
          ? undefined
          : () => {
              trackEvent({
                name: 'attention_feed_item_opened',
                props: {
                  surface,
                  category: item.category,
                  reason_code: item.primaryReason,
                  field_code: item.primaryField ?? 'none',
                  actionable: item.actionable,
                },
              });
              router.push(attentionDestinationHref(item.destination) as never);
            }
      }
    />
  );
}

interface AttentionStateNoticeProps {
  message: string;
  onRetry?: () => void;
}

/** A qualified, non-clean state line. Never rendered as an all-clear. */
export function AttentionStateNotice({ message, onRetry }: AttentionStateNoticeProps) {
  const colors = useThemeColors();
  return (
    <Card className="mb-2 border-status-warning">
      <View className="flex-row items-start">
        <View className="mr-2 mt-0.5" style={{ flexShrink: 0 }}>
          <AlertTriangle color={colors.warning600} size={16} />
        </View>
        <View className="flex-1">
          <Text className="text-body-sm text-content-secondary" numberOfLines={3}>
            {message}
          </Text>
          {onRetry ? (
            <View className="self-start mt-2">
              <Button variant="secondary" size="sm" onPress={onRetry}>
                {ATTENTION_FEED_COPY.retry}
              </Button>
            </View>
          ) : null}
        </View>
      </View>
    </Card>
  );
}

/**
 * Which qualified state lines a surface must render. Extracted so Home and the
 * full screen cannot drift on what counts as "not clean".
 */
export function attentionStateNotices(feed: UseAttentionFeedResult): {
  message: string;
  retryable: boolean;
}[] {
  const notices: { message: string; retryable: boolean }[] = [];
  if (feed.serverPhase === 'blocked') {
    notices.push({ message: ATTENTION_FEED_COPY.serverBlocked, retryable: false });
  } else if (feed.serverPhase === 'error' || feed.serverPhase === 'stale_error') {
    notices.push({ message: ATTENTION_FEED_COPY.serverError, retryable: true });
  } else if (feed.serverPhase === 'partial') {
    // Name the ACTUAL cause. `partial` now covers two different failures, and
    // reporting a metadata-contract problem as a timing one would send whoever
    // investigates to the wrong place.
    const timing = feed.uncheckableTimingRowCount > 0;
    const metadata = feed.uncheckableMetadataRowCount > 0;
    notices.push({
      message:
        timing && metadata
          ? ATTENTION_FEED_COPY.classificationPartialMixed
          : metadata
            ? ATTENTION_FEED_COPY.classificationPartialMetadata
            : ATTENTION_FEED_COPY.classificationPartial,
      retryable: true,
    });
  }
  // A response with no usable pagination proof cannot claim to have covered
  // anything — it is qualified, never all-clear.
  if (
    (feed.serverPhase === 'success' || feed.serverPhase === 'partial') &&
    feed.coverage === 'unknown'
  ) {
    notices.push({ message: ATTENTION_FEED_COPY.coverageUnknown, retryable: true });
  }
  if (feed.localSettled && !feed.localComplete) {
    notices.push({ message: ATTENTION_FEED_COPY.localUnknown, retryable: true });
  }
  return notices;
}

/** Bounded-page qualifier. Never "View all N". */
export function attentionCoverageFooter(feed: UseAttentionFeedResult): string | null {
  if (!feed.isTruncated) return null;
  return feed.serverItems.length > 0
    ? ATTENTION_FEED_COPY.truncatedSummary(feed.serverItems.length, feed.checkedCount)
    : ATTENTION_FEED_COPY.cleanTruncated(feed.checkedCount);
}

/**
 * Whether Home renders the section at all.
 *
 * Hiding it entirely is itself a claim — the absence of a "Needs Attention"
 * block reads as "nothing to do". So the section stays for any qualified state:
 * loaded rows, a retry/partial notice, or a bounded page that could not cover
 * the practice. Only a genuinely settled, coverage-complete, clean feed hides
 * it, which keeps a quiet Home quiet without ever presenting a truncated or
 * failed check as all-clear.
 */
export function homeAttentionHasContent(feed: UseAttentionFeedResult): boolean {
  if (feed.items.length > 0) return true;
  if (attentionStateNotices(feed).length > 0) return true;
  // An UNSETTLED feed has checked nothing yet, so hiding the block would present
  // "not looked yet" as "nothing to do" on an otherwise normal Home — exactly
  // the claim this function exists to avoid. BOTH sources count: the server page
  // routinely settles before the slower SecureStore/native local read, and that
  // mixed state would otherwise hide the section with the local source still
  // unchecked. Only a settled, coverage-complete, clean feed hides.
  if (!feed.isSettled || !feed.localSettled) return true;
  return feed.coverage !== 'complete';
}

/** True while the section is visible but has no verdict to show yet. */
export function homeAttentionIsChecking(feed: UseAttentionFeedResult): boolean {
  return (!feed.isSettled || !feed.localSettled) && feed.items.length === 0;
}

interface AttentionFeedSectionProps {
  feed: UseAttentionFeedResult;
}

/**
 * Home's "Needs Attention" section: at most three ACTIONABLE rows, a collapsed
 * practice-wide summary, and qualified state lines. Deliberately never expands
 * read-only patient rows on the landing screen, and never renders a single
 * authoritative count mixing device-local rows with a truncated server page.
 */
export function AttentionFeedSection({ feed }: AttentionFeedSectionProps) {
  const router = useRouter();
  const notices = attentionStateNotices(feed);
  const visibleRows = feed.groups.needsYou.slice(0, HOME_ATTENTION_ROW_LIMIT);
  const hiddenNeedsYou = feed.groups.needsYou.length - visibleRows.length;
  const acrossPracticeCount = feed.groups.acrossPractice.length;
  const coverageFooter = attentionCoverageFooter(feed);

  // The link appears when a LOADED row is omitted here, or when the full screen
  // carries the qualifier/retry detail. It never implies a deeper fetch.
  const showViewLink =
    hiddenNeedsYou > 0 ||
    acrossPracticeCount > 0 ||
    feed.isTruncated ||
    feed.coverage === 'unknown' ||
    notices.length > 0;

  return (
    <View className="mb-6">
      <View className="flex-row justify-between items-center mb-3">
        <Text className="section-title" accessibilityRole="header">
          {ATTENTION_FEED_COPY.sectionTitle}
        </Text>
        {showViewLink ? (
          <Pressable
            onPress={() => router.push('/recordings/attention' as never)}
            accessibilityRole="link"
            accessibilityLabel={ATTENTION_FEED_COPY.viewRecent}
            hitSlop={HIT_SLOP}
            style={{ minHeight: 32, justifyContent: 'center' }}
          >
            {/* Trailing space + flexShrink:0 — Android under-measures short Text in flex-rows and clips the last glyph; do NOT remove. */}
            <Text
              className="text-body-sm text-brand-500 font-medium"
              style={{ flexShrink: 0, paddingRight: 2 }}
            >
              {`${ATTENTION_FEED_COPY.viewRecent} `}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {notices.map((notice) => (
        <AttentionStateNotice
          key={notice.message}
          message={notice.message}
          onRetry={notice.retryable ? feed.refresh : undefined}
        />
      ))}

      {/* "Checking…" is a state, not a verdict — it must never read as clean. */}
      {homeAttentionIsChecking(feed) ? (
        <Text className="text-body-sm text-content-tertiary mb-2">
          {ATTENTION_FEED_COPY.loading}
        </Text>
      ) : null}

      {visibleRows.map((item) => (
        <AttentionItemRow key={item.key} item={item} surface="home" />
      ))}

      {acrossPracticeCount > 0 ? (
        <Pressable
          onPress={() => router.push('/recordings/attention' as never)}
          accessibilityRole="button"
          accessibilityLabel={`${ATTENTION_FEED_COPY.acrossPracticeSummary(acrossPracticeCount)}. ${ATTENTION_FEED_COPY.acrossPracticeExpandHint}`}
          className="rounded-xl border border-border-default bg-surface-raised px-4 py-2.5 items-center mb-2"
          hitSlop={HIT_SLOP}
        >
          <Text className="text-body-sm font-medium text-content-secondary">
            {ATTENTION_FEED_COPY.acrossPracticeSummary(acrossPracticeCount)}
          </Text>
        </Pressable>
      ) : null}

      {coverageFooter ? (
        <Text className="text-caption text-content-tertiary mt-1">{coverageFooter}</Text>
      ) : null}
    </View>
  );
}
