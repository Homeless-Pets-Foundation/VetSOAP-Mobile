export const MFA_REQUEST_TIMEOUT_MS = 30000;

function objectProp(error: unknown, key: string): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as Record<string, unknown>)[key];
}

export function apiErrorCode(error: unknown): string | undefined {
  const code = objectProp(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

export function apiErrorStatus(error: unknown): number | undefined {
  const status = objectProp(error, 'status');
  return typeof status === 'number' ? status : undefined;
}

export function isSetupApprovalCodeError(error: unknown): boolean {
  const code = apiErrorCode(error);
  return (
    code === 'MFA_BOOTSTRAP_CODE_REQUIRED' ||
    code === 'MFA_BOOTSTRAP_CODE_INVALID' ||
    code === 'MFA_BOOTSTRAP_CODE_CONSUMED'
  );
}

export function mfaErrorMessage(error: unknown): string {
  const code = apiErrorCode(error);
  const status = apiErrorStatus(error);

  if (code === 'MFA_BOOTSTRAP_CODE_REQUIRED') {
    return 'Enter the setup approval code to continue.';
  }
  if (code === 'MFA_BOOTSTRAP_CODE_INVALID') {
    return 'The setup approval code is invalid. Try again.';
  }
  if (code === 'MFA_BOOTSTRAP_CODE_CONSUMED') {
    return 'The setup approval code has already been used. Request a new code.';
  }
  if (code === 'MFA_FACTOR_NOT_FOUND') {
    return 'No verified authenticator app is enrolled for this account.';
  }
  if (code === 'MFA_REQUIRED') {
    return 'Multi-factor authentication is required.';
  }
  if (code === 'REFRESH_TOKEN_REQUIRED' || code === 'AUTH_REQUIRED' || status === 401) {
    return 'Your session could not be verified. Please sign in again.';
  }
  if (code === 'MFA_REQUEST_TIMEOUT') {
    return 'The verification request timed out. Please try again.';
  }
  if (status === 429) {
    return 'Too many requests. Please try again shortly.';
  }
  if (typeof status === 'number' && status >= 500) {
    return 'A server error occurred. Please try again later.';
  }
  if (status === 0) {
    return 'Unable to reach the authentication server. Please check your connection.';
  }
  return 'Unable to verify your identity. Please try again.';
}
