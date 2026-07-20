/**
 * Bound a Promise without leaving a rejected source Promise unobserved.
 *
 * The source operation may be a native bridge call that cannot be cancelled.
 * Attaching both settlement handlers keeps a late native rejection handled
 * after the deadline has already recovered the UI.
 */
export function withPromiseTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
