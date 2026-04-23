/**
 * Global "what is the user doing right now" marker, shared between the
 * AppState listener in `app/_layout.tsx` and the producers that know when
 * the user transitions (record.tsx sets 'record' / 'upload' / 'idle').
 *
 * Used only to tag `app_state_change` events so a "recorder was running
 * when the OS backgrounded us" pattern surfaces as a dashboard rather than
 * a support ticket. Not load-bearing for any business logic.
 */

export type SessionActivity = 'record' | 'upload' | 'idle';

let current: SessionActivity = 'idle';

export function setSessionActivity(activity: SessionActivity): void {
  current = activity;
}

export function getSessionActivity(): SessionActivity {
  return current;
}
