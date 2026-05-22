import type { Recording, User } from '../types';

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
