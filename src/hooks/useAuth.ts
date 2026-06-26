import { useContext } from 'react';
import {
  AuthActionsContext,
  AuthContext,
  AuthDeviceRegistrationContext,
  AuthMfaContext,
  AuthReadinessContext,
  AuthUserContext,
} from '../auth/AuthProvider';

export function useAuth() {
  return useContext(AuthContext);
}

export function useAuthUser() {
  return useContext(AuthUserContext);
}

export function useAuthReadiness() {
  return useContext(AuthReadinessContext);
}

export function useAuthActions() {
  return useContext(AuthActionsContext);
}

export function useAuthDeviceRegistration() {
  return useContext(AuthDeviceRegistrationContext);
}

export function useAuthMfa() {
  return useContext(AuthMfaContext);
}
