// Server-side read of the /pulls rows' CI and review state (see
// app/api/pull-statuses).

import {
  ACCESS_FIELD_ERRORS,
  type GraphQLErrorTolerance,
  sendGitHubGraphQL,
} from './githubCommitServer';
import { githubFetch } from './githubFetch';
import {
  parsePullStatusesPayload,
  PULL_STATUS_CHUNK_SIZE,
  PULL_STATUSES_QUERY,
  type PullStatus,
} from './githubPullSummaries';
import { createAsyncLRU, credentialCacheScope } from './serverLRU';

// Pulls the token can't read come back as null nodes with access errors.
const STATUSES_TOLERANCE: GraphQLErrorTolerance = {
  types: ACCESS_FIELD_ERRORS,
  paths: [['nodes']],
};

// Reads PULL_STATUSES_QUERY for `ids` in chunks of `chunkSize`, all chunks at
// once: GitHub resolves one request's nodes one after another, so several
// small requests finish sooner than one large one. Also used by the
// profiler (lib/pullsSearchProfile), which times other chunk sizes.
export async function readPullStatuses(
  ids: readonly string[],
  token: string,
  chunkSize: number,
  signal?: AbortSignal
): Promise<Record<string, PullStatus>> {
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += chunkSize) {
    chunks.push(ids.slice(start, start + chunkSize));
  }
  const results = await Promise.all(
    chunks.map(async (chunk) =>
      parsePullStatusesPayload(
        await sendGitHubGraphQL(
          PULL_STATUSES_QUERY,
          { ids: chunk },
          token,
          (url, init) => githubFetch(url, { ...init, signal }),
          { tolerate: STATUSES_TOLERANCE }
        )
      )
    )
  );
  return Object.assign({}, ...results) as Record<string, PullStatus>;
}

// How long the server reuses a pull's status for the same token and
// updatedAt: long enough that reloading or another tab doesn't pay GitHub's
// status read again. Stacked on the client's own cache (lib/pullStatusCache)
// this bounds how late CI finishing (which doesn't bump updatedAt) can show
// at about two minutes.
const PULL_STATUS_CACHE_TTL_MS = 60_000;

// null records a pull the token couldn't read, so it isn't re-asked either.
const statusCache = createAsyncLRU<string, PullStatus | null>({
  maxEntries: 5000,
  ttlMs: PULL_STATUS_CACHE_TTL_MS,
});

// Reads already on their way to GitHub, by cache key, so a request that
// arrives meanwhile (another tab, a reload mid-read) waits for them instead
// of reading the same pulls again.
const pendingStatuses = new Map<string, Promise<PullStatus | null>>();

// readPullStatuses with a short-lived per-pull cache in front. `versions`
// holds each id's updatedAt as the list reported it (same order as `ids`);
// a pull that changed has a new updatedAt and so misses the cache. Ids
// without a version are always read. Pulls another request is already
// reading join that read; only the rest go to GitHub, in the usual parallel
// chunks. A read can serve several requests, so it isn't tied to any one
// request's abort signal: one that's abandoned still fills the cache.
export async function readCachedPullStatuses(
  ids: readonly string[],
  versions: readonly (string | undefined)[],
  token: string
): Promise<Record<string, PullStatus>> {
  const scope = credentialCacheScope(token);
  const keyFor = (index: number) => {
    const version = versions[index];
    return version == null ? null : `${scope}\n${ids[index]}\n${version}`;
  };
  const statuses: Record<string, PullStatus> = {};
  const joined: Promise<void>[] = [];
  const misses: number[] = [];
  ids.forEach((id, index) => {
    const key = keyFor(index);
    const cached = key == null ? undefined : statusCache.peek(key);
    const pending = key == null ? undefined : pendingStatuses.get(key);
    if (cached !== undefined) {
      if (cached != null) {
        statuses[id] = cached;
      }
    } else if (pending != null) {
      joined.push(
        pending.then((status) => {
          if (status != null) {
            statuses[id] = status;
          }
        })
      );
    } else {
      misses.push(index);
    }
  });
  if (misses.length > 0) {
    const read = readPullStatuses(
      misses.map((index) => ids[index]),
      token,
      PULL_STATUS_CHUNK_SIZE
    );
    for (const index of misses) {
      const id = ids[index];
      const key = keyFor(index);
      const status = read.then((result) => result[id] ?? null);
      if (key != null) {
        pendingStatuses.set(key, status);
        // Settled reads move to the cache; failed ones are forgotten so the
        // next request retries. The catch only keeps this bookkeeping chain
        // from reporting the failure a second time.
        status
          .then(
            (value) => statusCache.set(key, value),
            () => {}
          )
          .finally(() => pendingStatuses.delete(key))
          .catch(() => {});
      }
      joined.push(
        status.then((value) => {
          if (value != null) {
            statuses[id] = value;
          }
        })
      );
    }
  }
  await Promise.all(joined);
  return statuses;
}

// For tests: forget every cached status.
export function clearPullStatusCache(): void {
  statusCache.clear();
  pendingStatuses.clear();
}
