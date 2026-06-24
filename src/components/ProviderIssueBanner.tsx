import React, { useCallback, useEffect } from 'react';
import { AppState, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react-native';
import { providerIssuesApi, type ProviderIssue } from '../api/providerIssues';
import { Banner } from './ui/Banner';
import { useAuth } from '../hooks/useAuth';

const PROVIDER_LABELS: Record<string, string> = {
  z_ai: 'Z.ai',
  gemini: 'Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

function providerLabel(provider: string | null | undefined): string {
  if (!provider) return 'selected provider';
  return PROVIDER_LABELS[provider] ?? provider;
}

function errorClassLabel(errorClass: string): string {
  return errorClass.replace(/_/g, ' ');
}

function providerWithModel(issue: ProviderIssue): string {
  const label = providerLabel(issue.primaryProvider);
  return issue.primaryModel ? `${label} ${issue.primaryModel}` : label;
}

function messageForIssue(issue: ProviderIssue): string {
  const fallback = issue.fallbackProvider
    ? `${providerLabel(issue.fallbackProvider)} fallback is completing SOAP notes.`
    : 'SOAP generation may not complete automatically until this is fixed.';
  const code = issue.externalCode ? ` (code ${issue.externalCode})` : '';
  return `${providerWithModel(issue)} needs attention. ${fallback} ${providerLabel(
    issue.primaryProvider
  )} reported ${errorClassLabel(issue.errorClass)}${code}. ${issue.recommendedAction}`;
}

export function ProviderIssueBanner({ location }: { location: 'home' | 'settings' }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const canView = user?.role === 'owner' || user?.role === 'admin';
  const queryKey = ['organization', 'provider-issues', 'active'] as const;

  const { data, refetch } = useQuery({
    queryKey,
    queryFn: () => providerIssuesApi.list({ status: 'active', days: 1 }),
    enabled: canView,
    staleTime: 60_000,
  });

  const acknowledgeMutation = useMutation({
    mutationFn: (issueKey: string) => providerIssuesApi.acknowledge(issueKey),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization', 'provider-issues'] }).catch(() => {});
      queryClient.invalidateQueries({ queryKey }).catch(() => {});
    },
  });

  useFocusEffect(
    useCallback(() => {
      if (canView) refetch().catch(() => {});
    }, [canView, refetch])
  );

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      try {
        if (nextState === 'active' && canView) {
          refetch().catch(() => {});
        }
      } catch (error) {
        if (__DEV__) console.error('[ProviderIssueBanner] foreground refresh failed:', error);
      }
    });
    return () => subscription.remove();
  }, [canView, refetch]);

  if (!canView) return null;
  const issue = data?.issues.find((item) => item.actionableByOrgAdmin);
  if (!issue) return null;

  return (
    <View className="mb-4">
      <Banner
        variant="warning"
        icon={AlertTriangle}
        message={messageForIssue(issue)}
        cta={
          location === 'settings'
            ? {
                label: acknowledgeMutation.isPending ? 'Dismissing' : 'Dismiss',
                onPress: () => acknowledgeMutation.mutate(issue.issueKey),
              }
            : {
                label: 'Settings',
                onPress: () => router.push('/settings' as never),
              }
        }
        dismissible={location === 'home'}
      />
    </View>
  );
}
