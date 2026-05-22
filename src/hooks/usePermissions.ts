import { useContext } from 'react';
import { AuthContext } from '../auth/AuthProvider';
import type { Recording } from '../types';
import { getRecordingPermissions, type RecordingPermissions } from '../lib/recordingPermissions';

export type { RecordingPermissions };

export function useRecordingPermissions(recording: Recording | null | undefined): RecordingPermissions {
  const { user } = useContext(AuthContext);

  return getRecordingPermissions(user, recording);
}
