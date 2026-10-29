import { type PlainFetch } from './plainFetch';

// Wraps `fetcher` so at most `limit` requests are in flight; later calls
// wait in FIFO order. A finishing request hands its slot straight to the next
// waiter rather than freeing it, so a new caller cannot slip in between. A slot frees once the response headers
// arrive, so callers that still read the body afterwards are not counted
// against the limit. A caller whose abort signal fires while it is still
// waiting leaves the queue and rejects with the signal's reason, so a
// cancelled request never sits behind unrelated ones.
export function createLimitedFetch(
  limit: number,
  fetcher: PlainFetch
): PlainFetch {
  let active = 0;
  // Insertion-ordered, so the first entry is the longest waiter, and a
  // cancelled waiter is removed in constant time.
  const waiting = new Set<() => void>();
  const acquire = (signal: AbortSignal | undefined): Promise<void> => {
    signal?.throwIfAborted();
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', cancel);
        resolve();
      };
      const cancel = () => {
        waiting.delete(grant);
        reject(signal?.reason);
      };
      waiting.add(grant);
      signal?.addEventListener('abort', cancel, { once: true });
    });
  };
  const release = () => {
    const [next] = waiting;
    if (next == null) {
      active -= 1;
    } else {
      waiting.delete(next);
      next();
    }
  };
  return async (input, init) => {
    await acquire(
      init?.signal ?? (input instanceof Request ? input.signal : undefined)
    );
    try {
      return await fetcher(input, init);
    } finally {
      release();
    }
  };
}
