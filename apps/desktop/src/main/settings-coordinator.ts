/**
 * Main's settings serializer, extracted from the store so it can be tested
 * without electron.
 *
 * Main has two kinds of operation on settings.json: MUTATIONS (a locked
 * read/modify/write in @hivemind/core) and RELOADS (a plain read after the CLI
 * edited the file). Both end in a publish to the renderer, and running them
 * concurrently reorders those publishes:
 *
 *   reload A reads the old file → CLI writes → reload B reads the new file →
 *   A publishes first (old), B publishes second (new)              … or, with a
 *   freshness counter instead of a queue, B is DROPPED as "stale" because A
 *   published after B started, and main is left holding the old settings.
 *
 * A sequence number cannot fix that: it can tell you something else published,
 * never whether your own read is older or newer than that publish. So the
 * operations are serialized instead — one at a time, FIFO, with the read and
 * the publish inside the same critical section. Then a reload's read always
 * happens after the previous operation's publish, and "last publish wins" is
 * also "newest read wins".
 */

/** The one settled value, published inside the critical section. */
export interface SettingsCoordinator<T> {
  /** Re-read (a foreign writer changed the file) and publish. */
  reload(): Promise<T>;
  /** Locked read/modify/write, then publish. */
  mutate(apply: () => Promise<T>): Promise<T>;
  /** Operations queued or running. */
  depth(): number;
}

export function createSettingsCoordinator<T>(io: {
  read: () => Promise<T>;
  /** Called with each settled value, in completion order, inside the queue. */
  publish: (value: T) => void;
}): SettingsCoordinator<T> {
  let queue: Promise<unknown> = Promise.resolve();
  let depth = 0;

  const run = <R extends T>(work: () => Promise<R>): Promise<R> => {
    depth++;
    const next = queue.then(async () => {
      try {
        const value = await work();
        io.publish(value);
        return value;
      } finally {
        depth--;
      }
    });
    // The queue must survive a failed operation: a rejected write (a lock we
    // could not take) must not wedge every later read behind it.
    queue = next.catch(() => {});
    return next;
  };

  return {
    reload: () => run(io.read),
    mutate: (apply) => run(apply),
    depth: () => depth,
  };
}
