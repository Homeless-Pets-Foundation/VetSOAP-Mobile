import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Linking, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CalendarClock, ChevronLeft, CreditCard, DollarSign, ExternalLink, Users } from 'lucide-react-native';
import { accountApi, type SubscriptionInfo } from '../../src/api/account';
import { CONTENT_MAX_WIDTH } from '../../src/components/ui/ScreenContainer';
import { Card } from '../../src/components/ui/Card';
import { IconButton } from '../../src/components/ui/IconButton';
import { Button } from '../../src/components/ui/Button';
import { EmptyState } from '../../src/components/ui/EmptyState';
import { useAuthUser } from '../../src/hooks/useAuth';
import { useResponsive } from '../../src/hooks/useResponsive';
import { useThemeColors } from '../../src/hooks/useThemeColors';
import { trackEvent } from '../../src/lib/analytics';
import { SUBSCRIPTION_COPY } from '../../src/constants/strings';

const ALLOWED_BILLING_HOSTS = ['billing.stripe.com', 'checkout.stripe.com', 'invoice.stripe.com'];

function formatDate(value?: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatStatus(status?: string | null): string {
  switch (status) {
    case 'trial':
    case 'trialing':
      return SUBSCRIPTION_COPY.statusTrial;
    case 'active':
      return SUBSCRIPTION_COPY.statusActive;
    case 'past_due':
      return SUBSCRIPTION_COPY.statusPastDue;
    case 'canceled':
      return SUBSCRIPTION_COPY.statusCanceled;
    default:
      return typeof status === 'string' && status.trim()
        ? status.replace(/_/g, ' ')
        : SUBSCRIPTION_COPY.statusUnknown;
  }
}

function formatCents(cents?: number | null, cycle?: 'monthly' | 'annual'): string | null {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return null;
  const suffix = cycle === 'annual' ? '/yr' : '/mo';
  const hasCents = Math.abs(cents % 100) > Number.EPSILON;
  return `$${(cents / 100).toFixed(hasCents ? 2 : 0)}${suffix}`;
}

function isAllowedBillingUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ALLOWED_BILLING_HOSTS.includes(parsed.host);
  } catch {
    return false;
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
  const user = useAuthUser();
  const { iconMd, iconSm, iconLg } = useResponsive();
  const colors = useThemeColors();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const trackedStatusRef = useRef<string | null>(null);
  const canViewBilling = user?.role === 'owner' || user?.role === 'admin';

  const { data, isLoading, isError, refetch } = useQuery<SubscriptionInfo>({
    queryKey: ['account-subscription'],
    queryFn: accountApi.getSubscription,
    enabled: canViewBilling,
  });

  const portalMutation = useMutation({
    mutationFn: accountApi.createBillingPortalSession,
    onSuccess: (response) => {
      if (!isAllowedBillingUrl(response.url)) {
        Alert.alert(SUBSCRIPTION_COPY.openFailedTitle, SUBSCRIPTION_COPY.openFailedBody);
        return;
      }
      Linking.openURL(response.url).catch(() => {
        Alert.alert(SUBSCRIPTION_COPY.openFailedTitle, SUBSCRIPTION_COPY.openFailedBody);
      });
    },
    onError: () => {
      Alert.alert(SUBSCRIPTION_COPY.openFailedTitle, SUBSCRIPTION_COPY.openFailedBody);
    },
  });

  useEffect(() => {
    if (!data?.status || trackedStatusRef.current === data.status) return;
    trackedStatusRef.current = data.status;
    trackEvent({ name: 'subscription_viewed', props: { status: data.status } });
  }, [data?.status]);

  const handleRefresh = useCallback(() => {
    if (!canViewBilling) return;
    setIsRefreshing(true);
    refetch()
      .finally(() => setIsRefreshing(false))
      .catch(() => {});
  }, [canViewBilling, refetch]);

  const trialDate = formatDate(data?.trialEndsAt);
  const seats = typeof data?.seatCount === 'number' ? SUBSCRIPTION_COPY.seats(data.seatCount) : null;
  const billableAmount = formatCents(data?.billableAmount, data?.billingCycle);
  const canManagePortal = data?.capabilities.canManagePortal === true;

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
          refreshControl={
            canViewBilling
              ? <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />
              : undefined
          }
        >
          {!canViewBilling ? (
            <EmptyState
              contained
              icon={CreditCard}
              iconSize={iconLg}
              description={SUBSCRIPTION_COPY.adminOnly}
            />
          ) : isLoading ? (
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
                  {data.plan.name || SUBSCRIPTION_COPY.defaultPlan}
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
                {seats ? (
                  <InfoRow
                    label={SUBSCRIPTION_COPY.seatsLabel}
                    value={seats}
                    icon={<Users color={colors.brand500} size={iconSm} />}
                  />
                ) : null}
                {billableAmount ? (
                  <InfoRow
                    label={data.billingCycle === 'annual' ? SUBSCRIPTION_COPY.annualTotal : SUBSCRIPTION_COPY.monthlyTotal}
                    value={billableAmount}
                    icon={<DollarSign color={colors.brand500} size={iconSm} />}
                  />
                ) : null}
                {!trialDate && !seats && !billableAmount ? (
                  <Text className="text-body text-content-secondary">{SUBSCRIPTION_COPY.noBillingDates}</Text>
                ) : null}
              </Card>

              <Button
                onPress={() => {
                  portalMutation.mutate();
                }}
                disabled={!canManagePortal}
                loading={portalMutation.isPending}
                icon={<ExternalLink color={colors.contentOnBrand} size={iconSm} />}
              >
                {SUBSCRIPTION_COPY.manageBilling}
              </Button>
              {!canManagePortal ? (
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
