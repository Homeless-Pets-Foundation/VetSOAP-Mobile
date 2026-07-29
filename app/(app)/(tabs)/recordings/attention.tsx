import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, Pressable, SectionList, RefreshControl, BackHandler } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { ChevronDown, ChevronLeft, ChevronRight, CheckCircle2 } from 'lucide-react-native';
import { useAttentionFeed, useAttentionImpression } from '../../../../src/hooks/useAttentionFeed';
import { useResponsive } from '../../../../src/hooks/useResponsive';
import { useThemeColors } from '../../../../src/hooks/useThemeColors';
import { CONTENT_MAX_WIDTH } from '../../../../src/components/ui/ScreenContainer';
import { SkeletonCard } from '../../../../src/components/ui/Skeleton';
import {
  AttentionItemRow,
  AttentionStateNotice,
  attentionCoverageFooter,
  attentionStateNotices,
} from '../../../../src/components/AttentionFeedSection';
import { ATTENTION_FEED_COPY } from '../../../../src/constants/strings';
import type { AttentionFeedItem } from '../../../../src/lib/attentionFeed';

interface AttentionSection {
  key: 'needs_you' | 'across_practice';
  title: string;
  data: AttentionFeedItem[];
  /** Row count actually LOADED for this group (never a server-page estimate). */
  count: number;
  collapsible: boolean;
  expanded: boolean;
}

export default function AttentionScreen() {
  const router = useRouter();
  const colors = useThemeColors();
  const { iconMd } = useResponsive();
  const focused = useIsFocused();
  const feed = useAttentionFeed({ focused });
  useAttentionImpression('attention_screen', feed, focused);

  // "Across the practice" starts collapsed so read-only rows never bury
  // actionable work. Expanding it must not alter "Needs you" order.
  const [practiceExpanded, setPracticeExpanded] = useState(false);

  const notices = attentionStateNotices(feed);
  const coverageFooter = attentionCoverageFooter(feed);

  const sections = useMemo<AttentionSection[]>(() => {
    const result: AttentionSection[] = [];
    if (feed.groups.needsYou.length > 0) {
      result.push({
        key: 'needs_you',
        title: ATTENTION_FEED_COPY.needsYouGroup,
        data: feed.groups.needsYou,
        count: feed.groups.needsYou.length,
        collapsible: false,
        expanded: true,
      });
    }
    if (feed.groups.acrossPractice.length > 0) {
      result.push({
        key: 'across_practice',
        title: ATTENTION_FEED_COPY.acrossPracticeGroup,
        data: practiceExpanded ? feed.groups.acrossPractice : [],
        count: feed.groups.acrossPractice.length,
        collapsible: true,
        expanded: practiceExpanded,
      });
    }
    return result;
  }, [feed.groups.acrossPractice, feed.groups.needsYou, practiceExpanded]);

  /**
   * Deterministically return to this tab's list instead of trusting history.
   *
   * `router.back()` follows the ROOT navigator history, so when the user
   * arrived from Home it undoes the TAB SWITCH rather than popping this screen.
   * The Recordings tab then re-opens on this screen forever and its list is
   * unreachable from the tab bar — reproduced on an Android emulator. The list
   * is this screen's stack parent, so naming it is both correct and stable.
   * Home stays one tap away in the tab bar.
   */
  const goBack = useCallback(() => {
    router.replace('/recordings');
  }, [router]);

  // Android hardware back must take the SAME deterministic route; the
  // navigator default is exactly the root-history pop described above.
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        goBack();
        return true;
      });
      return () => subscription.remove();
    }, [goBack])
  );

  // The stable refresh identity keeps RefreshControl from re-subscribing on
  // every render.
  const refreshFeed = feed.refresh;
  const handleRefresh = useCallback(() => {
    refreshFeed();
  }, [refreshFeed]);

  /**
   * A collapsed "Across the practice" group renders zero ITEMS while still
   * representing loaded rows, so the empty/clean state keys off the loaded row
   * count rather than SectionList's item count.
   *
   * There is deliberately no early-return loader: the screen, its Back control,
   * and every state line stay usable even if a query or a native local read
   * hangs (rule 24).
   */
  const emptyState = useMemo(() => {
    if (feed.items.length > 0) return null;
    // EITHER unsettled source is still "loading". Keying off `isSettled` alone
    // left a cold open blank for up to the eight-second local timeout whenever
    // the server page won the race: no rows, `isClean` false, and no local
    // notice yet, so every branch below fell through to `null`.
    if (!feed.isSettled || !feed.localSettled) {
      return (
        <View>
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </View>
      );
    }
    if (feed.isClean) {
      return (
        <View className="items-center py-8">
          <CheckCircle2 color={colors.statusSuccessFg} size={32} />
          <Text className="text-body text-content-secondary mt-3 text-center">
            {ATTENTION_FEED_COPY.clean}
          </Text>
        </View>
      );
    }
    if (coverageFooter) {
      return (
        <Text className="text-body-sm text-content-tertiary py-6 text-center">
          {coverageFooter}
        </Text>
      );
    }
    return null;
  }, [
    colors.statusSuccessFg,
    coverageFooter,
    feed.isClean,
    feed.isSettled,
    feed.localSettled,
    feed.items.length,
  ]);

  return (
    <SafeAreaView className="screen items-center">
      <View style={{ flex: 1, width: '100%', maxWidth: CONTENT_MAX_WIDTH }}>
        <View className="flex-row items-center px-5 pt-5 pb-3">
          <Pressable
            onPress={goBack}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            className="mr-3 w-11 h-11 items-center justify-center"
          >
            <ChevronLeft color={colors.contentPrimary} size={iconMd} />
          </Pressable>
          <Text
            className="text-display font-bold text-content-primary flex-1"
            accessibilityRole="header"
            numberOfLines={1}
          >
            {ATTENTION_FEED_COPY.sectionTitle}
          </Text>
        </View>

        <SectionList
          sections={sections}
          keyExtractor={(item) => item.key}
          contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 24 }}
          refreshControl={
            <RefreshControl refreshing={feed.isRefreshing} onRefresh={handleRefresh} />
          }
          stickySectionHeadersEnabled={false}
          renderItem={({ item }) => <AttentionItemRow item={item} surface="attention_screen" />}
          renderSectionHeader={({ section }) => {
            const typed = section as unknown as AttentionSection;
            const label = `${typed.title} (${typed.count})`;
            if (!typed.collapsible) {
              return (
                <Text className="section-title mt-2 mb-3" accessibilityRole="header">
                  {label}
                </Text>
              );
            }
            return (
              <Pressable
                onPress={() => setPracticeExpanded((expanded) => !expanded)}
                accessibilityRole="button"
                accessibilityLabel={`${label}. ${ATTENTION_FEED_COPY.acrossPracticeExpandHint}`}
                accessibilityState={{ expanded: typed.expanded }}
                className="flex-row items-center justify-between mt-4 mb-3 py-2"
              >
                <Text className="section-title flex-1" numberOfLines={1}>
                  {label}
                </Text>
                {typed.expanded ? (
                  <ChevronDown color={colors.contentTertiary} size={18} />
                ) : (
                  <ChevronRight color={colors.contentTertiary} size={18} />
                )}
              </Pressable>
            );
          }}
          ListHeaderComponent={
            <View>
              {notices.map((notice) => (
                <AttentionStateNotice
                  key={notice.message}
                  message={notice.message}
                  onRetry={notice.retryable ? feed.refresh : undefined}
                />
              ))}
            </View>
          }
          ListEmptyComponent={emptyState}
          ListFooterComponent={
            coverageFooter && feed.items.length > 0 ? (
              <Text className="text-caption text-content-tertiary mt-3">{coverageFooter}</Text>
            ) : null
          }
        />
      </View>
    </SafeAreaView>
  );
}
