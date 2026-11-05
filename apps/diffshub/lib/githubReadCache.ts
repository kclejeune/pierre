// Cached, immutable GitHub reads for the pull-conflicts route. Every cached
// value is addressed by commit, tree, or blob SHA (a compare between two
// SHAs, a tree listing, a commit's root tree, a blob, a file at a commit), so
// an entry can never go stale. Reading contents by blob SHA where it is known
// keeps them cached across pushes that leave the file alone; the TTL and size limits only bound storage.
//
// Authorization: the cache is shared across viewers, so a hit is returned only
// after this request has confirmed, live and with the caller's own token, that
// the caller can read the repository (one `GET /repos/{owner}/{repo}` per repo
// per request, started on the first hit, skipped for repos the caller has
// already read with that token). A miss is a live read, which GitHub
// authorizes itself.
//
// Confidentiality: keys are a hash of the GitHub instance URL plus the
// logical key, so repository names and paths never appear in the store. With
// DIFFSHUB_TOKEN_ENCRYPTION_KEY set, the hash is an HMAC and values are
// AES-256-GCM sealed under subkeys derived from the instance key (HKDF), with
// the store key bound as additional data; rotating the instance key makes
// every old entry unreadable, and they age out by TTL.
//
// Any store failure falls back to the live read: the cache can make a request
// faster but never fail it.

import { cacheEntry } from './githubCacheCodec';
import {
  type CacheStore,
  getGitHubCacheLimits,
  getGitHubCacheStore,
  type GitHubCacheLimits,
} from './githubCacheStore';
import {
  fetchGitHubJSON,
  fetchTreeListing,
  getCommitTreeSha,
  GitHubCommitError,
  type GitRepoRef,
  memoizeTreeLister,
  parseGitHubErrorMessage,
  readStringPath,
  repoPath,
  type TreeLister,
} from './githubCommitServer';
import { createGitHubRawAPIHeaders } from './githubDiffFileServer';
import { encodePath, encodeURLSegment } from './githubDiffSource';
import {
  createGitHubAPIURL,
  getGitHubEnvironment,
  getTokenEncryptionKey,
} from './githubEnvironment';
import { githubFetch } from './githubFetch';
import type { CompareFile } from './pullMerge';
import { getCurrentRouteLabel } from './requestLog';
import { emitLogLine, formatError, logUpstreamFailure } from './serverLog';
import { asRecord } from './untypedJson';

// GitHub caps compare-API file listings at 300 entries. A listing at the cap
// may be incomplete, so callers treat it as unknown and walk trees instead.
const COMPARE_FILES_CAP = 300;

export interface CompareSummary {
  baseTreeSha?: string;
  // The changed files, or null when the listing may be incomplete (at the
  // cap or missing from the response).
  files: CompareFile[] | null;
  mergeBaseSha?: string;
  mergeBaseTreeSha?: string;
}

export interface GitHubReads {
  commitTreeSha(repo: GitRepoRef, commitSha: string): Promise<string>;
  // `range` must name commits by SHA (`<sha>...<sha>` or `<sha>...<owner>:<sha>`).
  compare(repo: GitRepoRef, range: string): Promise<CompareSummary>;
  // A blob's contents, by its SHA.
  blob(repo: GitRepoRef, blobSha: string): Promise<string>;
  // File contents at a commit, or null when the path does not exist there.
  fileAtCommit(
    repo: GitRepoRef,
    commitSha: string,
    path: string
  ): Promise<string | null>;
  treeLister(repo: GitRepoRef): TreeLister;
}

export interface GitHubReadsOptions {
  // Repos this request has already read live with the same token (e.g. the
  // pull itself), so cache hits there need no separate access check.
  accessibleRepos?: GitRepoRef[];
  // Defaults to the configured store, limits, and instance key; tests inject.
  encryptionKey?: Uint8Array<ArrayBuffer>;
  limits?: GitHubCacheLimits | null;
  store?: CacheStore;
}

export function createGitHubReads(
  token: string | undefined,
  options: GitHubReadsOptions = {}
): GitHubReads {
  const limits =
    options.limits === undefined ? getGitHubCacheLimits() : options.limits;
  const encryptionKey =
    'encryptionKey' in options
      ? options.encryptionKey
      : getTokenEncryptionKey();
  const storePromise: Promise<CacheStore | undefined> =
    limits == null
      ? Promise.resolve(undefined)
      : options.store != null
        ? Promise.resolve(options.store)
        : getGitHubCacheStore().catch(logCacheError);
  const instance = getGitHubEnvironment().apiURL;

  const accessChecks = new Map<string, Promise<unknown>>(
    (options.accessibleRepos ?? []).map((repo) => [
      repoId(repo),
      Promise.resolve(),
    ])
  );
  const ensureAccess = (repo: GitRepoRef) => {
    const id = repoId(repo);
    let check = accessChecks.get(id);
    if (check == null) {
      check = fetchGitHubJSON(repoPath(repo, ''), token);
      accessChecks.set(id, check);
    }
    return check;
  };

  // Serves `logical` from the cache once access to `repo` is confirmed, or
  // reads it live and stores the result.
  const cached = async <T>(
    repo: GitRepoRef,
    logical: (string | number)[],
    live: () => Promise<T>
  ): Promise<T> => {
    const store = await storePromise;
    if (store == null || limits == null) {
      return live();
    }
    const entry = cacheEntry(
      { encryptionKey, limits, store },
      JSON.stringify([instance, repoId(repo), ...logical])
    );
    const hit = await entry.read().catch(logCacheError);
    if (hit !== undefined) {
      await ensureAccess(repo);
      return hit as T;
    }
    const value = await live();
    await entry.write(value).catch(logCacheError);
    return value;
  };

  // One memoized lister per repo; the cache sits under the memo, so each tree
  // SHA is read (from the store or live) once per request.
  const listers = new Map<string, TreeLister>();
  return {
    commitTreeSha: (repo, commitSha) =>
      cached(repo, ['commit-tree', commitSha], () =>
        getCommitTreeSha(repo, token, commitSha)
      ),
    compare: (repo, range) =>
      cached(repo, ['compare', range], async () =>
        summarizeCompare(
          await fetchGitHubJSON(
            repoPath(repo, `/compare/${encodeURLSegment(range)}`),
            token
          )
        )
      ),
    blob: (repo, blobSha) =>
      cached(repo, ['blob', blobSha], () =>
        fetchRaw(repo, `/git/blobs/${encodeURLSegment(blobSha)}`, token)
      ).then((contents) => {
        if (contents == null) {
          throw new GitHubCommitError(
            `Blob ${blobSha} was not found.`,
            'github',
            502
          );
        }
        return contents;
      }),
    fileAtCommit: (repo, commitSha, path) =>
      cached(repo, ['file', commitSha, path], () =>
        fetchRaw(repo, `/contents/${encodePath(path)}`, token, {
          ref: commitSha,
        })
      ),
    treeLister(repo) {
      const id = repoId(repo);
      let lister = listers.get(id);
      if (lister == null) {
        lister = memoizeTreeLister((treeSha) =>
          cached(repo, ['tree', treeSha], async () => [
            ...(await fetchTreeListing(repo, token, treeSha)),
          ]).then((entries) => new Map(entries))
        );
        listers.set(id, lister);
      }
      return lister;
    },
  };
}

function repoId(repo: GitRepoRef): string {
  return `${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`;
}

// Keeps only what the merge planner reads; full compare payloads carry every
// file's patch and would dwarf the useful part.
function summarizeCompare(compare: unknown): CompareSummary {
  return {
    baseTreeSha: readStringPath(compare, [
      'base_commit',
      'commit',
      'tree',
      'sha',
    ]),
    files: readCompareFiles(compare),
    mergeBaseSha: readStringPath(compare, ['merge_base_commit', 'sha']),
    mergeBaseTreeSha: readStringPath(compare, [
      'merge_base_commit',
      'commit',
      'tree',
      'sha',
    ]),
  };
}

const COMPARE_STATUSES = new Set([
  'added',
  'changed',
  'copied',
  'modified',
  'removed',
  'renamed',
  'unchanged',
]);

function readCompareFiles(compare: unknown): CompareFile[] | null {
  const files = asRecord(compare)?.files;
  if (!Array.isArray(files) || files.length >= COMPARE_FILES_CAP) {
    return null;
  }
  return files.flatMap((file) => {
    const record = asRecord(file);
    const filename = record?.filename;
    const status = record?.status;
    if (
      typeof filename !== 'string' ||
      typeof status !== 'string' ||
      !COMPARE_STATUSES.has(status)
    ) {
      return [];
    }
    const entry: CompareFile = {
      filename,
      status: status as CompareFile['status'],
    };
    if (typeof record?.previous_filename === 'string') {
      entry.previousFilename = record.previous_filename;
    }
    if (status !== 'removed' && typeof record?.sha === 'string') {
      entry.sha = record.sha;
    }
    return [entry];
  });
}

// A raw-media GET (file bytes rather than base64 JSON) under the repo's API
// path, or null on 404.
async function fetchRaw(
  repo: GitRepoRef,
  path: string,
  token: string | undefined,
  query?: Record<string, string>
): Promise<string | null> {
  const url = createGitHubAPIURL(
    getGitHubEnvironment(),
    repoPath(repo, path),
    query
  );
  const response = await githubFetch(url, {
    cache: 'no-store',
    headers: createGitHubRawAPIHeaders(token),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const detail = parseGitHubErrorMessage(await response.text());
    logUpstreamFailure({
      credential: token == null || token === '' ? 'none' : 'viewer',
      error: detail === '' ? undefined : detail,
      response,
      route: getCurrentRouteLabel('unknown'),
      upstreamURL: url,
    });
    throw new GitHubCommitError(
      detail === '' ? `Fetching ${path} failed (${response.status}).` : detail,
      'github',
      response.status
    );
  }
  return response.text();
}

// One log line per process for the first cache failure, so a dead store is
// visible without one line per request.
let cacheErrorLogged = false;

function logCacheError(error: unknown): undefined {
  if (!cacheErrorLogged) {
    cacheErrorLogged = true;
    emitLogLine({
      error: formatError(error),
      event: 'github_cache_error',
      level: 'warn',
    });
  }
  return undefined;
}
