/**
 * Bound a Promise without leaving a rejected source Promise unobserved.
 *
 * The source operation may be a native bridge call that cannot be cancelled.
 * Attaching both settlement handlers keeps a late native rejection handled
 * after the deadline has already recovered the UI.
 */
export type PromiseTimeoutError = Error | (() => Error);

const PROMISE_TIMEOUT_FACTORY_FALLBACK = 'The operation timed out.';

export function withPromiseTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  timeoutError?: PromiseTimeoutError,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    // Attach both source handlers before arming the deadline. Native reads are
    // not cancellable, so these handlers must already be observing a source
    // that rejects after the public Promise has timed out.
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        if (timeout !== null) clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        if (timeout !== null) clearTimeout(timeout);
        reject(error);
      },
    );

    if (settled) return;
    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      let rejection: Error;
      try {
        const supplied =
          typeof timeoutError === 'function' ? timeoutError() : timeoutError;
        rejection = supplied instanceof Error ? supplied : new Error(message);
      } catch {
        // A timer callback is a void callback. Never let a bad factory throw
        // out of it and become a Hermes unhandled exception.
        rejection = new Error(PROMISE_TIMEOUT_FACTORY_FALLBACK);
      }
      reject(rejection);
    }, Math.max(0, timeoutMs));
  });
}
