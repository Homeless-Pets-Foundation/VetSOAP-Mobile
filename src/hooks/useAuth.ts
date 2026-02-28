import { useContext } from 'react';
import { AuthContext } from '../auth/AuthProvider';

export function useAuth() {
  return useContext(AuthContext);
}
