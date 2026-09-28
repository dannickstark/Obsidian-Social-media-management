/**
 * The task's value when it settles within `ms`, otherwise `fallback`. A rejection within `ms` is passed on; a later
 * one is swallowed (the race has already handled it). The timer is always cleared.
 */
export function withTimeout<T, F>(task: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let handle: number | undefined;
  const timeout = new Promise<F>((resolve) => {
    handle = window.setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([task, timeout]).finally(() => window.clearTimeout(handle));
}

/** True when `task` settles (either way) within `ms`; never rejects. */
export function settlesWithin(task: Promise<unknown>, ms: number): Promise<boolean> {
  return withTimeout(
    task.then(
      () => true,
      () => true,
    ),
    ms,
    false,
  );
}
