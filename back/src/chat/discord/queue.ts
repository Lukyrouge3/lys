// One promise chain per key, so a slow turn in one channel cannot stall another
// channel, while two turns in the same channel still never interleave.
export type KeyedQueue = {
  /** Queues `task` behind the previous task for `key`; rejects if `task` does. */
  run: (key: string, task: () => Promise<void>) => Promise<void>;
  /** How many keys currently have a chain (0 once everything has drained). */
  size: () => number;
};

export function createKeyedQueue(): KeyedQueue {
  const chains = new Map<string, Promise<void>>();

  function run(key: string, task: () => Promise<void>): Promise<void> {
    const previous = chains.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    // The map stores the settled version: a rejected task is reported to its
    // caller but never poisons the next task queued on this key.
    const settled = result.catch(() => {});
    chains.set(key, settled);
    void settled.finally(() => {
      // Only drop the entry if nothing else was queued behind this task.
      if (chains.get(key) === settled) chains.delete(key);
    });
    return result;
  }

  return { run, size: () => chains.size };
}
