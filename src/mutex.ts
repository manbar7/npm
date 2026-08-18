/**
 * A simple async mutex: queues callers so that only one critical section runs at
 * a time. This is the only concurrency primitive currently in the codebase.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    // Keep the chain alive even if this caller rejects.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * One `Mutex` per key, so unrelated keys never queue behind each other.
 */
export class KeyedMutex {
  private readonly locks = new Map<string, Mutex>();

  private lockFor(key: string): Mutex {
    let mutex = this.locks.get(key);
    if (!mutex) {
      mutex = new Mutex();
      this.locks.set(key, mutex);
    }
    return mutex;
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.lockFor(key).run(fn);
  }

  /**
   * Acquires every key's lock, always in sorted order, so two callers that need
   * the same pair of keys (e.g. a transfer and its reverse) can never deadlock
   * by acquiring them in opposite order.
   */
  runMany<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(keys)].sort();
    const acquire = (index: number): Promise<T> =>
      index === sorted.length
        ? fn()
        : this.lockFor(sorted[index]!).run(() => acquire(index + 1));
    return acquire(0);
  }
}
