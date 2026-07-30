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

/**
 * The ROLE is part of the key because `listItemsForUserStrict` is role-dependent:
 * owner/admin may recover a pending-confirm-only item, while a veterinarian
 * needs complete local audio. Without it, the same signed-in user changing role
 * without a sign-out would keep the previous role's count and completeness —
 * advertising work the new role cannot restore, or hiding work after promotion.
 */
export function supportRecoveryVaultQueryKey(
  userId: string | null | undefined,
  organizationId: string | null | undefined,
  role: string | null | undefined
): unknown[] {
  return [
    'support-recovery',
    'vault-summary',
    userId ?? 'anonymous',
    organizationId ?? 'none',
    role ?? 'none',
  ];
}

export function useSupportRecoveryVaultSummary(): SupportRecoveryVaultSummary {
  const user = useAuthUser();
  const enabled = !!user?.id && !!user.organizationId && canRecordAppointments(user.role);

  const query = useQuery({
    queryKey: supportRecoveryVaultQueryKey(user?.id, user?.organizationId, user?.role),
    enabled,
    staleTime: 60_000,
    // No retries: this read is ALREADY bounded by its own timeout, and the global
    // policy retries non-ApiError failures twice. A hanging SecureStore or
    // filesystem probe would therefore hold the hook in `loading` for ~3 timeout
    // windows plus backoff — Home suppresses the recovery banner throughout —
    // and each retry would start another native read while the timed-out one may
    // still be running. One bounded attempt, then the advertised `unknown`.
    retry: false,
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
