import { useContext } from 'react';
import { AuthContext } from '../auth/AuthProvider';
import type { Recording } from '../types';

export interface RecordingPermissions {
  canEdit: boolean;
  canDelete: boolean;
  canExport: boolean;
  canCopy: boolean;
  canRetry: boolean;
}

export function useRecordingPermissions(recording: Recording | null | undefined): RecordingPermissions {
  const { user } = useContext(AuthContext);

  if (!user || !recording) {
    return {
      canEdit: false,
      canDelete: false,
      canExport: false,
      canCopy: false,
      canRetry: false,
    };
  }

  const isAuthor = recording.userId === user.id;
  const isPrivileged = user.role === 'owner' || user.role === 'admin';
  const canModify = isAuthor || isPrivileged;

  return {
    canEdit: canModify,
    canDelete: canModify,
    canRetry: canModify,
    canExport: true,
    canCopy: true,
  };
}
