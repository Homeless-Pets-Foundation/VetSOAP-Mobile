import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supportStaffRecoveryVault } from '../lib/supportStaffRecoveryVault';
import { withPromiseTimeout } from '../lib/promiseTimeout';
import { canRecordAppointments } from '../lib/recordingPermissions';
import { useAuthUser } from './useAuth';

/**
 * Bounded, STRICT, read-only count of support-staff recovery-vault items this
 * user may recover on this tablet.
 *
 * Preserved clinical work was previously discoverable only in Settings and
 * `/(app)/recording-recovery` — too hidden. It belongs in Home's higher-priority
 * RECOVERY banner stack, NOT in the attention feed: keeping it out of feed
 * counts is what stops recovery being announced twice.
 *
 * An unknown read renders a compact retry state, never a false zero.
 */
export const SUPPORT_RECOVERY_READ_TIMEOUT_MS = 8_000;

export type SupportRecoveryVaultState = 'disabled' | 'loading' | 'known' | 'unknown';

export interface SupportRecoveryVaultSummary {
  state: SupportRecoveryVaultState;
  count: number;
  refresh: () => void;
}

export function supportRecoveryVaultQueryKey(
  userId: string | null | undefined,
  organizationId: string | null | undefined
): unknown[] {
  return ['support-recovery', 'vault-summary', userId ?? 'anonymous', organizationId ?? 'none'];
}

export function useSupportRecoveryVaultSummary(): SupportRecoveryVaultSummary {
  const user = useAuthUser();
  const enabled = !!user?.id && !!user.organizationId && canRecordAppointments(user.role);

  const query = useQuery({
    queryKey: supportRecoveryVaultQueryKey(user?.id, user?.organizationId),
    enabled,
    staleTime: 60_000,
    queryFn: async () => {
      const snapshot = await withPromiseTimeout(
        supportStaffRecoveryVault.listItemsForUserStrict({
          id: user!.id,
          role: user!.role,
          organizationId: user!.organizationId,
        }),
        SUPPORT_RECOVERY_READ_TIMEOUT_MS,
        'support_recovery_vault_timeout'
      );
      return { count: snapshot.items.length, complete: snapshot.recoverabilityComplete };
    },
  });

  const refresh = useCallback(() => {
    if (!enabled) return;
    query.refetch().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  if (!enabled) return { state: 'disabled', count: 0, refresh };
  if (query.isError) return { state: 'unknown', count: 0, refresh };
  if (!query.data) return { state: 'loading', count: 0, refresh };
  if (!query.data.complete) return { state: 'unknown', count: 0, refresh };
  return { state: 'known', count: query.data.count, refresh };
}
