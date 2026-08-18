import { encodePath, encodeURLSegment } from './githubDiffSource';
import {
  createGitHubAPIURL,
  createGitHubJSONHeaders,
  getGitHubEnvironment,
} from './githubEnvironment';
import { createJSONResponse } from './jsonResponse';

// Git Data API helpers for writing commits: blob/tree/commit creation and the
// non-force ref update that lands them. Used by the pull-commit and
// pull-conflicts routes. Every function takes an explicit token — writes are
// always authored as the requester, never the deployment fallback token — and
// an injectable fetch so the request/response contracts are unit-testable.

type ServerFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => ReturnType<typeof fetch>;

export interface GitRepoRef {
  owner: string;
  repo: string;
}

// One path's write in a new tree. `sha: null` deletes the path; a mode of
// '100644'/'100755'/etc. mirrors the entry being replaced so the executable
// bit survives edits.
export interface GitTreeWrite {
  path: string;
  mode: string;
  sha: string | null;
}

export type GitHubCommitErrorCode =
  | 'forbidden'
  | 'github'
  | 'protected-branch'
  | 'stale-head';

export class GitHubCommitError extends Error {
  code: GitHubCommitErrorCode;
  status: number;

  constructor(message: string, code: GitHubCommitErrorCode, status: number) {
    super(message);
    this.name = 'GitHubCommitError';
    this.code = code;
    this.status = status;
  }
}

// Maps a thrown error onto the JSON error response both write routes return:
// the GitHubCommitError code decides the status (stale-head → 409, forbidden
// → 403, protected-branch → 422, otherwise GitHub's own status when sane),
// and anything else reads as GitHub being unreachable.
export function commitErrorResponse(error: unknown): Response {
  if (error instanceof GitHubCommitError) {
    const status =
      error.code === 'stale-head'
        ? 409
        : error.code === 'forbidden'
          ? 403
          : error.code === 'protected-branch'
            ? 422
            : error.status >= 400 && error.status < 600
              ? error.status
              : 502;
    return createJSONResponse(
      { code: error.code, error: error.message },
      { status }
    );
  }
  return createJSONResponse(
    { error: 'The GitHub API could not be reached.' },
    { status: 502 }
  );
}

async function gitDataRequest(
  path: string,
  token: string | undefined,
  init: { method: 'GET' | 'PATCH' | 'POST'; body?: unknown },
  fetcher: ServerFetch
): Promise<unknown> {
  const response = await fetcher(
    createGitHubAPIURL(getGitHubEnvironment(), path),
    {
      method: init.method,
      headers: {
        ...createGitHubJSONHeaders(token),
        ...(init.body == null ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init.body == null ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
    }
  );
  if (!response.ok) {
    const detail = (await response.text()).trim();
    throw new GitHubCommitError(
      detail === ''
        ? `GitHub request ${path} failed (${response.status}).`
        : detail,
      classifyGitHubWriteFailure(response.status, detail),
      response.status
    );
  }
  return response.json();
}

// Maps GitHub's write-failure responses onto the small set of causes the UI
// can act on. 422 is GitHub's catch-all for ref-update rejections, so the
// body text disambiguates a moved branch from branch protection.
function classifyGitHubWriteFailure(
  status: number,
  detail: string
): GitHubCommitErrorCode {
  if (status === 401 || status === 403) {
    return 'forbidden';
  }
  if (status === 422 && /not a fast forward/i.test(detail)) {
    return 'stale-head';
  }
  if (status === 422 && /protected branch/i.test(detail)) {
    return 'protected-branch';
  }
  return 'github';
}

export function repoPath(repo: GitRepoRef, suffix: string): string {
  return `/repos/${encodeURLSegment(repo.owner)}/${encodeURLSegment(repo.repo)}${suffix}`;
}

function readString(data: unknown, key: string): string | undefined {
  if (typeof data !== 'object' || data == null) {
    return undefined;
  }
  const value = (data as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export async function createBlob(
  repo: GitRepoRef,
  token: string,
  contents: string,
  fetcher: ServerFetch = fetch
): Promise<string> {
  const data = await gitDataRequest(
    repoPath(repo, '/git/blobs'),
    token,
    { method: 'POST', body: { content: contents, encoding: 'utf-8' } },
    fetcher
  );
  const sha = readString(data, 'sha');
  if (sha == null) {
    throw new GitHubCommitError(
      'Blob creation returned no sha.',
      'github',
      502
    );
  }
  return sha;
}

export async function createTree(
  repo: GitRepoRef,
  token: string,
  baseTreeSha: string,
  entries: readonly GitTreeWrite[],
  fetcher: ServerFetch = fetch
): Promise<string> {
  const data = await gitDataRequest(
    repoPath(repo, '/git/trees'),
    token,
    {
      method: 'POST',
      body: {
        base_tree: baseTreeSha,
        tree: entries.map((entry) => ({
          mode: entry.mode,
          path: entry.path,
          sha: entry.sha,
          type: 'blob',
        })),
      },
    },
    fetcher
  );
  const sha = readString(data, 'sha');
  if (sha == null) {
    throw new GitHubCommitError(
      'Tree creation returned no sha.',
      'github',
      502
    );
  }
  return sha;
}

export async function createCommit(
  repo: GitRepoRef,
  token: string,
  input: { message: string; treeSha: string; parents: readonly string[] },
  fetcher: ServerFetch = fetch
): Promise<string> {
  const data = await gitDataRequest(
    repoPath(repo, '/git/commits'),
    token,
    {
      method: 'POST',
      body: {
        message: input.message,
        parents: input.parents,
        tree: input.treeSha,
      },
    },
    fetcher
  );
  const sha = readString(data, 'sha');
  if (sha == null) {
    throw new GitHubCommitError(
      'Commit creation returned no sha.',
      'github',
      502
    );
  }
  return sha;
}

export async function updateRef(
  repo: GitRepoRef,
  token: string,
  branch: string,
  sha: string,
  fetcher: ServerFetch = fetch
): Promise<void> {
  await gitDataRequest(
    repoPath(repo, `/git/refs/heads/${encodePath(branch)}`),
    token,
    // force: false makes GitHub reject a non-fast-forward update, which is
    // the compare-and-swap that keeps a moved branch from being clobbered.
    { method: 'PATCH', body: { force: false, sha } },
    fetcher
  );
}

export async function getCommitTreeSha(
  repo: GitRepoRef,
  token: string,
  commitSha: string,
  fetcher: ServerFetch = fetch
): Promise<string> {
  const data = await gitDataRequest(
    repoPath(repo, `/git/commits/${encodeURLSegment(commitSha)}`),
    token,
    { method: 'GET' },
    fetcher
  );
  const treeSha =
    typeof data === 'object' && data != null
      ? readString((data as Record<string, unknown>).tree, 'sha')
      : undefined;
  if (treeSha == null) {
    throw new GitHubCommitError(
      `Commit ${commitSha} returned no tree sha.`,
      'github',
      502
    );
  }
  return treeSha;
}

// Resolves `{sha, mode}` for a path inside a tree, or null when the path does
// not exist. Walks one directory level per request and memoizes each listed
// directory, so resolving many paths in one commit re-fetches nothing.
export function createTreeEntryResolver(
  repo: GitRepoRef,
  token: string,
  fetcher: ServerFetch = fetch
): (
  rootTreeSha: string,
  path: string
) => Promise<{ sha: string; mode: string } | null> {
  const directoryCache = new Map<
    string,
    Promise<{ mode: string; path: string; sha: string; type: string }[]>
  >();

  const listTree = (treeSha: string) => {
    let pending = directoryCache.get(treeSha);
    if (pending == null) {
      pending = gitDataRequest(
        repoPath(repo, `/git/trees/${encodeURLSegment(treeSha)}`),
        token,
        { method: 'GET' },
        fetcher
      ).then((data) => {
        const entries =
          typeof data === 'object' && data != null
            ? (data as Record<string, unknown>).tree
            : undefined;
        if (!Array.isArray(entries)) {
          return [];
        }
        return entries.flatMap((entry) => {
          const mode = readString(entry, 'mode');
          const path = readString(entry, 'path');
          const sha = readString(entry, 'sha');
          const type = readString(entry, 'type');
          return mode != null && path != null && sha != null && type != null
            ? [{ mode, path, sha, type }]
            : [];
        });
      });
      directoryCache.set(treeSha, pending);
    }
    return pending;
  };

  return async (rootTreeSha, path) => {
    const segments = path.split('/').filter(Boolean);
    let treeSha = rootTreeSha;
    for (let index = 0; index < segments.length; index += 1) {
      const entries = await listTree(treeSha);
      const entry = entries.find(
        (candidate) => candidate.path === segments[index]
      );
      if (entry == null) {
        return null;
      }
      if (index === segments.length - 1) {
        return entry.type === 'blob'
          ? { mode: entry.mode, sha: entry.sha }
          : null;
      }
      if (entry.type !== 'tree') {
        return null;
      }
      treeSha = entry.sha;
    }
    return null;
  };
}

// Authenticated JSON GET against the GitHub API that throws GitHubCommitError
// on failure — the read-side companion to gitDataRequest, shared by the
// pull-commit and pull-conflicts routes. `token` may be absent for reads that
// fall back to anonymous access.
export function fetchGitHubJSON(
  path: string,
  token: string | undefined,
  fetcher: ServerFetch = fetch
): Promise<unknown> {
  return gitDataRequest(path, token, { method: 'GET' }, fetcher);
}

// Reads a nested string off an untyped GitHub payload, or undefined when any
// step of the path is missing or non-string.
export function readStringPath(
  data: unknown,
  path: readonly string[]
): string | undefined {
  let current: unknown = data;
  for (const key of path) {
    if (typeof current !== 'object' || current == null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}

export function parseRepoFullName(
  fullName: string | undefined
): GitRepoRef | undefined {
  if (fullName == null) {
    return undefined;
  }
  const separator = fullName.indexOf('/');
  if (separator <= 0 || separator === fullName.length - 1) {
    return undefined;
  }
  return {
    owner: fullName.slice(0, separator),
    repo: fullName.slice(separator + 1),
  };
}

// The head/base refs every commit flow needs from a pull-request payload.
export interface PullRefs {
  baseRef: string;
  baseRepo: GitRepoRef;
  baseSha: string;
  headRef: string;
  headRepo: GitRepoRef;
  headSha: string;
}

export function fetchPullData(
  repo: GitRepoRef,
  pull: string,
  token: string | undefined,
  fetcher: ServerFetch = fetch
): Promise<unknown> {
  return fetchGitHubJSON(
    repoPath(repo, `/pulls/${encodeURLSegment(pull)}`),
    token,
    fetcher
  );
}

// Live tip of a branch. The pull payload's `base.sha` is a snapshot from
// when GitHub last re-synced the pull, not the branch head — it can lag the
// real base tip by many commits, which would make a merge plan built from it
// miss every base-side change.
export async function fetchBranchTipSha(
  repo: GitRepoRef,
  branch: string,
  token: string | undefined,
  fetcher: ServerFetch = fetch
): Promise<string> {
  const payload = await fetchGitHubJSON(
    repoPath(repo, `/git/ref/heads/${encodePath(branch)}`),
    token,
    fetcher
  );
  const sha = readStringPath(payload, ['object', 'sha']);
  if (sha == null) {
    throw new GitHubCommitError(
      `The branch ${branch} could not be resolved.`,
      'github',
      502
    );
  }
  return sha;
}

// After a commit lands on the head branch, GitHub updates the pull's head sha
// and regenerates its diff/mergeability in the background. Reloading before
// that finishes serves the pre-commit diff, so both commit routes wait until
// the pull reports the new head and a computed `mergeable`, bounded so a
// slow GitHub never wedges the response. Best-effort: timeouts and errors
// fall through and the client reloads regardless.
export async function waitForPullHead(
  repo: GitRepoRef,
  pull: string,
  expectedHeadSha: string,
  token: string | undefined,
  options: { intervalMs?: number; maxAttempts?: number } = {},
  fetcher: ServerFetch = fetch
): Promise<void> {
  const intervalMs = options.intervalMs ?? 750;
  const maxAttempts = options.maxAttempts ?? 12;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    try {
      const payload = await fetchPullData(repo, pull, token, fetcher);
      const headSha = readStringPath(payload, ['head', 'sha']);
      const mergeable =
        typeof payload === 'object' && payload != null
          ? (payload as Record<string, unknown>).mergeable
          : undefined;
      if (headSha === expectedHeadSha && typeof mergeable === 'boolean') {
        return;
      }
    } catch {
      return;
    }
  }
}

// Extracts the ref/sha/repo pairs from a pulls/{n} payload, throwing the 502
// GitHubCommitError both routes report when GitHub's response is malformed.
// `fallbackRepo` covers payloads whose repo objects are absent (deleted fork).
export function parsePullRefs(
  data: unknown,
  fallbackRepo: GitRepoRef
): PullRefs {
  const headSha = readStringPath(data, ['head', 'sha']);
  const headRef = readStringPath(data, ['head', 'ref']);
  const baseSha = readStringPath(data, ['base', 'sha']);
  const baseRef = readStringPath(data, ['base', 'ref']);
  if (
    headSha == null ||
    headRef == null ||
    baseSha == null ||
    baseRef == null
  ) {
    throw new GitHubCommitError(
      'The pull request response did not include refs.',
      'github',
      502
    );
  }
  return {
    baseRef,
    baseRepo:
      parseRepoFullName(readStringPath(data, ['base', 'repo', 'full_name'])) ??
      fallbackRepo,
    baseSha,
    headRef,
    headRepo:
      parseRepoFullName(readStringPath(data, ['head', 'repo', 'full_name'])) ??
      fallbackRepo,
    headSha,
  };
}
