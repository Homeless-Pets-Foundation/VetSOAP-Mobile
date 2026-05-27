import type { Recording, User } from '../types';

const RECORD_APPOINTMENT_ROLES = new Set(['owner', 'admin', 'veterinarian']);

export const RECORD_APPOINTMENT_PERMISSION_TITLE = 'Recording Not Available';
export const RECORD_APPOINTMENT_PERMISSION_MESSAGE =
  'This account cannot record or submit appointments. If this tablet already has unsent recordings, do not sign out or clear app data. Ask an owner, administrator, or veterinarian to recover them on this tablet, or have this same account temporarily promoted before submitting.';

export interface RecordingPermissions {
  canEdit: boolean;
  canDelete: boolean;
  canExport: boolean;
  canCopy: boolean;
  canRetry: boolean;
  deleteBlockedReason: string | null;
}

const NO_PERMISSIONS: RecordingPermissions = {
  canEdit: false,
  canDelete: false,
  canExport: false,
  canCopy: false,
  canRetry: false,
  deleteBlockedReason: 'Sign in to delete recordings.',
};

export function canRecordAppointments(role: string | null | undefined): boolean {
  return !!role && RECORD_APPOINTMENT_ROLES.has(role);
}

function deleteBlockedReason(
  user: Pick<User, 'id' | 'role'>,
  recording: Pick<Recording, 'userId'>
): string | null {
  if (user.role === 'support_staff') {
    return 'Your role cannot delete recordings.';
  }

  if (user.role === 'veterinarian' && recording.userId !== user.id) {
    return 'Only the recording owner or an administrator can delete this draft.';
  }

  if (user.role !== 'owner' && user.role !== 'admin' && user.role !== 'veterinarian') {
    return 'You do not have permission to delete this recording.';
  }

  return null;
}

export function getRecordingPermissions(
  user: Pick<User, 'id' | 'role'> | null | undefined,
  recording: Pick<Recording, 'userId'> | null | undefined
): RecordingPermissions {
  if (!user || !recording) {
    return NO_PERMISSIONS;
  }

  const isAuthor = recording.userId === user.id;
  const isPrivileged = user.role === 'owner' || user.role === 'admin';
  const canModify = isPrivileged || (user.role === 'veterinarian' && isAuthor);
  const blockedReason = canModify ? null : deleteBlockedReason(user, recording);

  return {
    canEdit: canModify,
    canDelete: canModify,
    canRetry: canModify,
    canExport: true,
    canCopy: true,
    deleteBlockedReason: blockedReason,
  };
}
