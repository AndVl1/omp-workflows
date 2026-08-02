/**
 * Tiny async helpers shared across the e2e package.
 */

/**
 * The classic "deferred promise" pattern: a Promise plus its bound
 * `resolve` / `reject` pair, returned together so callers can settle the
 * promise from elsewhere (event handlers, timers, …).
 *
 * This is the Node 20-compatible equivalent of `Promise.withResolvers()`
 * (which is Node 22+ / ES2024). The exported shape mirrors the built-in so
 * drop-in replacement at call sites is a one-token rename.
 */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
