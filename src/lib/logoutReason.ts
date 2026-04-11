type LogoutReason = 'session_expired' | null;

let _reason: LogoutReason = null;

export const setLogoutReason = (reason: LogoutReason): void => {
  _reason = reason;
};

export const consumeLogoutReason = (): LogoutReason => {
  const r = _reason;
  _reason = null;
  return r;
};
