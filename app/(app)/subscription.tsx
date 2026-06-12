import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, ChevronLeft, CreditCard, ExternalLink, Users } from 'lucide-react-native';
import { accountApi, type SubscriptionInfo } from '../../src/api/account';
import { CONTENT_MAX_WIDTH } from '../../src/components/ui/ScreenContainer';
import { Card } from '../../src/components/ui/Card';
import { IconButton } from '../../src/components/ui/IconButton';
import { Button } from '../../src/components/ui/Button';
import { EmptyState } from '../../src/components/ui/EmptyState';
import { useResponsive } from '../../src/hooks/useResponsive';
import { useThemeColors } from '../../src/hooks/useThemeColors';
import { trackEvent } from '../../src/lib/analytics';
import { SUBSCRIPTION_COPY } from '../../src/constants/strings';

function formatDate(value?: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatStatus(status: string): string {
  switch (status) {
    case 'trialing':
      return SUBSCRIPTION_COPY.statusTrial;
    case 'active':
      return SUBSCRIPTION_COPY.statusActive;
    case 'past_due':
      return SUBSCRIPTION_COPY.statusPastDue;
    case 'canceled':
      return SUBSCRIPTION_COPY.statusCanceled;
    default:
      return status.replace(/_/g, ' ');
  }
}

function InfoRow({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
}) {
  return (
    <View className="flex-row items-center py-3 border-b border-border-default last:border-b-0">
      <View className="w-9 h-9 rounded-full bg-surface-sunken justify-center items-center mr-3">
        {icon}
      </View>
      <View className="flex-1">
        <Text className="text-caption text-content-tertiary">{label}</Text>
        <Text className="text-body font-semibold text-content-primary mt-0.5" numberOfLines={2}>
          {value}
        </Text>
      </View>
    </View>
  );
}

export default function SubscriptionScreen() {
  const router = useRouter();
  const { iconMd, iconSm, iconLg } = useResponsive();
  const colors = useThemeColors();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const trackedStatusRef = useRef<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery<SubscriptionInfo>({
    queryKey: ['account-subscription'],
    queryFn: accountApi.getSubscription,
  });

  useEffect(() => {
    if (!data?.status || trackedStatusRef.current === data.status) return;
    trackedStatusRef.current = data.status;
    trackEvent({ name: 'subscription_viewed', props: { status: data.status } });
  }, [data?.status]);

  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    refetch()
      .finally(() => setIsRefreshing(false))
      .catch(() => {});
  }, [refetch]);

  const openManageBilling = useCallback(() => {
    if (!data?.manageUrl) return;
    Linking.openURL(data.manageUrl).catch(() => {
      Alert.alert(SUBSCRIPTION_COPY.openFailedTitle, SUBSCRIPTION_COPY.openFailedBody);
    });
  }, [data?.manageUrl]);

  const renewalDate = formatDate(data?.renewsAt);
  const trialDate = formatDate(data?.trialEndsAt);
  const seats =
    typeof data?.seatsUsed === 'number' && typeof data?.seatsTotal === 'number'
      ? SUBSCRIPTION_COPY.seats(data.seatsUsed, data.seatsTotal)
      : null;

  return (
    <SafeAreaView className="screen items-center">
      <View style={{ flex: 1, width: '100%', maxWidth: CONTENT_MAX_WIDTH }}>
        <View className="px-5 pt-5">
          <View className="flex-row items-center mb-6">
            <IconButton
              icon={<ChevronLeft color={colors.contentPrimary} size={iconMd} />}
              label={SUBSCRIPTION_COPY.goBack}
              onPress={() => router.back()}
              className="mr-3"
            />
            <Text className="text-display font-bold text-content-primary" accessibilityRole="header">
              {SUBSCRIPTION_COPY.title}
            </Text>
          </View>
        </View>

        <ScrollView
          className="flex-1 px-5"
          contentContainerStyle={{ paddingBottom: 28 }}
          refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />}
        >
          {isLoading ? (
            <Card className="p-8 items-center">
              <ActivityIndicator color={colors.brand500} />
            </Card>
          ) : isError || !data ? (
            <EmptyState
              contained
              icon={CreditCard}
              iconSize={iconLg}
              description={SUBSCRIPTION_COPY.loadFailed}
              action={{
                label: SUBSCRIPTION_COPY.retry,
                variant: 'secondary',
                onPress: () => {
                  refetch().catch(() => {});
                },
              }}
            />
          ) : (
            <>
              <Card className="p-5 mb-4">
                <Text className="text-caption text-content-tertiary mb-1">{SUBSCRIPTION_COPY.currentPlan}</Text>
                <Text className="text-title font-bold text-content-primary capitalize">
                  {data.plan || SUBSCRIPTION_COPY.defaultPlan}
                </Text>
                <Text className="text-body text-content-secondary mt-1">{formatStatus(data.status)}</Text>
              </Card>

              <Card className="p-5 mb-4">
                {trialDate ? (
                  <InfoRow
                    label={SUBSCRIPTION_COPY.trialEnds}
                    value={trialDate}
                    icon={<CalendarClock color={colors.brand500} size={iconSm} />}
                  />
                ) : null}
                {renewalDate ? (
                  <InfoRow
                    label={data.status === 'canceled' ? SUBSCRIPTION_COPY.accessEnds : SUBSCRIPTION_COPY.renews}
                    value={renewalDate}
                    icon={<CalendarClock color={colors.brand500} size={iconSm} />}
                  />
                ) : null}
                {seats ? (
                  <InfoRow
                    label={SUBSCRIPTION_COPY.seatsLabel}
                    value={seats}
                    icon={<Users color={colors.brand500} size={iconSm} />}
                  />
                ) : null}
                {!trialDate && !renewalDate && !seats ? (
                  <Text className="text-body text-content-secondary">{SUBSCRIPTION_COPY.noBillingDates}</Text>
                ) : null}
              </Card>

              <Button
                onPress={openManageBilling}
                disabled={!data.manageUrl}
                icon={<ExternalLink color={colors.contentOnBrand} size={iconSm} />}
              >
                {SUBSCRIPTION_COPY.manageBilling}
              </Button>
              {!data.manageUrl ? (
                <Text className="text-caption text-content-tertiary text-center mt-3">
                  {SUBSCRIPTION_COPY.billingPortalOwnersOnly}
                </Text>
              ) : null}
            </>
          )}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}
