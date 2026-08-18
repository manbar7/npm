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
