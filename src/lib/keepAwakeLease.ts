type MaybePromise = void | Promise<void>;

export interface KeepAwakeLease {
  release(): void;
}

function requestDeactivation(
  tag: string,
  deactivate: (tag: string) => MaybePromise,
): void {
  try {
    Promise.resolve(deactivate(tag)).catch(() => {});
  } catch {
    // Best-effort native cleanup; a synchronous bridge throw is recoverable.
  }
}

/**
 * Acquire without blocking upload startup. Release deactivates immediately,
 * then deactivates again if a slow activation resolves after that first call.
 */
export function acquireKeepAwakeLease(
  tag: string,
  activate: (tag: string) => MaybePromise,
  deactivate: (tag: string) => MaybePromise,
): KeepAwakeLease {
  let activation: Promise<boolean>;
  try {
    activation = Promise.resolve(activate(tag)).then(
      () => true,
      () => false,
    );
  } catch {
    activation = Promise.resolve(false);
  }

  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      requestDeactivation(tag, deactivate);
      activation
        .then((activated) => {
          if (activated) requestDeactivation(tag, deactivate);
        })
        .catch(() => {});
    },
  };
}
