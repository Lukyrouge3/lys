// A network call with no deadline is a queue with no exit: the job processor
// runs one job at a time, so a hung Nextcloud or Discord request would hold
// every job behind it forever. This puts a clock on the call instead.

/**
 * Resolves or rejects with `promise`, unless it takes longer than `ms`, in which
 * case it rejects with an error naming `label`. The clock is cleared either way,
 * and a late settlement of `promise` is swallowed rather than surfacing as an
 * unhandled rejection.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      reject(new Error(`${label} timed out after ${ms} ms`));
    }, ms);

    promise.then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
