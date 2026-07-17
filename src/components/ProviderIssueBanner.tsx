import React, { useCallback, useEffect } from 'react';
import { AppState, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react-native';
import { providerIssuesApi, type ProviderIssue } from '../api/providerIssues';
import { Banner } from './ui/Banner';
import { useAuthUser } from '../hooks/useAuth';

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

/**
 * Lead with the user impact; provider/model/code jargon is demoted to a
 * short trailing detail (2026-07 audit: the old message opened with
 * "Z.ai GLM-4.6 needs attention… reported rate limit (code 429)").
 */
function messageForIssue(issue: ProviderIssue): string {
  const impact = issue.outcome === 'fallback_success' && issue.fallbackProvider
    ? 'SOAP notes may be delayed — a backup AI provider is completing them.'
    : 'SOAP notes may be delayed — our AI provider is having issues.';
  const ownership = issue.actionableByOrgAdmin
    ? issue.recommendedAction
    : 'Captivet operations has been notified.';
  const code = issue.externalCode ? ` (${issue.externalCode})` : '';
  const detail = `Detail: ${providerWithModel(issue)} — ${errorClassLabel(issue.errorClass)}${code}.`;
  return `${impact} ${ownership} ${detail}`;
}

export function ProviderIssueBanner({ location }: { location: 'home' | 'settings' }) {
  const queryClient = useQueryClient();
  const user = useAuthUser();
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
  const issue = data?.issues[0];
  if (!issue) return null;

  return (
    <View className="mb-4">
      <Banner
        key={issue.issueKey}
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
                // Home offers the same server-side acknowledge Settings has —
                // the component-local X used to look identical but silently
                // reappear on next mount.
                label: acknowledgeMutation.isPending ? 'Dismissing' : 'Dismiss',
                onPress: () => acknowledgeMutation.mutate(issue.issueKey),
              }
        }
      />
    </View>
  );
}
