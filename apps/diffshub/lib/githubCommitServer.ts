import { encodePath, encodeURLSegment } from './githubDiffSource';
import {
  createGitHubAPIURL,
  createGitHubGraphQLURL,
  createGitHubJSONHeaders,
  getGitHubEnvironment,
} from './githubEnvironment';
import { githubFetch } from './githubFetch';
import {
  describeGitHubFailureBody,
  parseGitHubJSONBody,
} from './githubProxyResponse';
import { createJSONResponse } from './jsonResponse';
import { type PlainFetch } from './plainFetch';
import { getCurrentRouteLabel } from './requestLog';
import { logUpstreamFailure } from './serverLog';
import { asRecord } from './untypedJson';

// Git Data API helpers for writing commits: blob/tree/commit creation and the
// non-force ref update that lands them. Used by the pull-commit and
// pull-conflicts routes. Every function takes an explicit token — writes are
// always authored as the requester — and an injectable fetch so the
// request/response contracts are unit-testable.

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
  // 'commit' for a submodule gitlink (mode 160000); defaults to 'blob'.
  type?: LeafEntryType;
}

// The tree entries that sit at a path's leaf: files and submodule gitlinks.
type LeafEntryType = 'blob' | 'commit';

export interface LeafEntry {
  mode: string;
  sha: string;
  type: LeafEntryType;
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
  init: {
    method: 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';
    body?: unknown;
    // Overrides the REST URL built from `path` (e.g. the GraphQL endpoint).
    url?: string;
  },
  fetcher: PlainFetch
): Promise<unknown> {
  const url = init.url ?? createGitHubAPIURL(getGitHubEnvironment(), path);
  const response = await fetcher(url, {
    method: init.method,
    headers: {
      ...createGitHubJSONHeaders(token),
      ...(init.body == null ? {} : { 'Content-Type': 'application/json' }),
    },
    body: init.body == null ? undefined : JSON.stringify(init.body),
    cache: 'no-store',
  });
  if (!response.ok) {
    // Classify on the raw body: the phrases that disambiguate a 422 (e.g.
    // "protected branch") often live in nested errors[] entries that the
    // top-level `message` extraction drops.
    const body = await response.text();
    const detail = parseGitHubErrorMessage(body);
    // GitHub's message plus the permission headers tell a missing App
    // permission apart from a user without access.
    logUpstreamFailure({
      credential: token == null || token === '' ? 'none' : 'viewer',
      error: detail === '' ? undefined : detail,
      response,
      route: getCurrentRouteLabel('unknown'),
      upstreamURL: url,
    });
    throw new GitHubCommitError(
      detail === ''
        ? `GitHub request ${path} failed (${response.status}).`
        : detail,
      classifyGitHubWriteFailure(response.status, body),
      response.status
    );
  }
  const body = await parseGitHubJSONBody(response);
  if (body.problem != null) {
    throw new GitHubCommitError(body.problem, 'github', 502);
  }
  return body.data;
}

// GitHub errors are normally JSON objects with a user-facing `message` plus
// `errors[]` detail (see describeGitHubFailureBody). Keep non-JSON bodies
// intact for GitHub Enterprise proxies and older endpoints.
export function parseGitHubErrorMessage(body: string): string {
  const trimmed = body.trim();
  if (trimmed === '') {
    return '';
  }
  try {
    const message = describeGitHubFailureBody(JSON.parse(trimmed));
    return message !== '' ? message : trimmed;
  } catch {
    return trimmed;
  }
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
  fetcher: PlainFetch = githubFetch
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
  fetcher: PlainFetch = githubFetch
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
          type: entry.type ?? 'blob',
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
  fetcher: PlainFetch = githubFetch
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
  fetcher: PlainFetch = githubFetch
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
  token: string | undefined,
  commitSha: string,
  fetcher: PlainFetch = githubFetch
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

export interface TreeEntry {
  mode: string;
  sha: string;
  type: string;
}

export type TreeLister = (treeSha: string) => Promise<Map<string, TreeEntry>>;

// Lists one tree level (entries keyed by name). A truncated listing throws
// rather than silently hiding entries.
export async function fetchTreeListing(
  repo: GitRepoRef,
  token: string | undefined,
  treeSha: string,
  fetcher: PlainFetch = githubFetch
): Promise<Map<string, TreeEntry>> {
  const record = asRecord(
    await gitDataRequest(
      repoPath(repo, `/git/trees/${encodeURLSegment(treeSha)}`),
      token,
      { method: 'GET' },
      fetcher
    )
  );
  if (record?.truncated === true) {
    throw new GitHubCommitError(
      `Tree ${treeSha} has too many entries to list — use git locally.`,
      'github',
      422
    );
  }
  const entries = new Map<string, TreeEntry>();
  for (const entry of Array.isArray(record?.tree) ? record.tree : []) {
    const mode = readString(entry, 'mode');
    const path = readString(entry, 'path');
    const sha = readString(entry, 'sha');
    const type = readString(entry, 'type');
    if (mode != null && path != null && sha != null && type != null) {
      entries.set(path, { mode, sha, type });
    }
  }
  return entries;
}

// Memoizes `load` by tree SHA. Trees are content-addressed, so one lister can
// be shared by every walk and lookup in the same repository during a
// request: a directory that several commits share is fetched once.
export function memoizeTreeLister(load: TreeLister): TreeLister {
  const cache = new Map<string, Promise<Map<string, TreeEntry>>>();
  return (treeSha) => {
    let pending = cache.get(treeSha);
    if (pending == null) {
      pending = load(treeSha);
      cache.set(treeSha, pending);
    }
    return pending;
  };
}

export function createTreeLister(
  repo: GitRepoRef,
  token: string | undefined,
  fetcher: PlainFetch = githubFetch
): TreeLister {
  return memoizeTreeLister((treeSha) =>
    fetchTreeListing(repo, token, treeSha, fetcher)
  );
}

// Resolves the file or submodule gitlink at `path` inside `rootTreeSha`, or
// null when the path does not exist or is a directory. Walks one directory
// level per lookup through `list`, so resolving many paths re-fetches
// nothing.
export function createTreeEntryResolver(
  list: TreeLister,
  rootTreeSha: string
): (path: string) => Promise<LeafEntry | null> {
  return async (path) => {
    const segments = path.split('/').filter(Boolean);
    let treeSha = rootTreeSha;
    for (let index = 0; index < segments.length; index += 1) {
      const entry = (await list(treeSha)).get(segments[index]);
      if (entry == null) {
        return null;
      }
      if (index === segments.length - 1) {
        return entry.type === 'blob' || entry.type === 'commit'
          ? { mode: entry.mode, sha: entry.sha, type: entry.type }
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
  fetcher: PlainFetch = githubFetch
): Promise<unknown> {
  return gitDataRequest(path, token, { method: 'GET' }, fetcher);
}

// Authenticated JSON write against the GitHub API that throws
// GitHubCommitError on failure — used by routes whose GitHub call is a plain
// REST mutation (e.g. merging a pull) rather than the git data API above.
export function sendGitHubJSON(
  path: string,
  token: string | undefined,
  method: 'DELETE' | 'PATCH' | 'POST' | 'PUT',
  body: unknown,
  fetcher: PlainFetch = githubFetch
): Promise<unknown> {
  return gitDataRequest(path, token, { method, body }, fetcher);
}

// GraphQL reports most failures as HTTP 200 with errors[]; rethrow those as
// GitHubCommitError like REST failures.
export async function sendGitHubGraphQL(
  query: string,
  variables: Record<string, unknown>,
  token: string,
  fetcher: PlainFetch = githubFetch
): Promise<unknown> {
  const payload = asRecord(
    await gitDataRequest(
      '/graphql',
      token,
      {
        method: 'POST',
        body: { query, variables },
        url: createGitHubGraphQLURL(getGitHubEnvironment()),
      },
      fetcher
    )
  );
  const errors = payload?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const forbidden = readStringPath(errors[0], ['type']) === 'FORBIDDEN';
    logUpstreamFailure({
      credential: 'viewer',
      error: readStringPath(errors[0], ['message']) ?? 'GraphQL errors[]',
      route: getCurrentRouteLabel('unknown'),
      upstreamURL: createGitHubGraphQLURL(getGitHubEnvironment()),
    });
    throw new GitHubCommitError(
      readStringPath(errors[0], ['message']) ??
        'GitHub rejected the GraphQL request.',
      forbidden ? 'forbidden' : 'github',
      forbidden ? 403 : 422
    );
  }
  return payload?.data;
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
  fetcher: PlainFetch = githubFetch
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
  fetcher: PlainFetch = githubFetch
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

// GitHub computes a pull's mergeability lazily: `mergeable` is null until it
// has, and recomputes after either branch moves.
export function readPullMergeable(payload: unknown): boolean | null {
  const mergeable = asRecord(payload)?.mergeable;
  return typeof mergeable === 'boolean' ? mergeable : null;
}

// Re-reads pulls/{n} until `isSettled` accepts the payload or the attempts run
// out, and returns the last payload either way. Errors propagate to the
// caller, which decides whether a failed poll matters.
async function pollPullData(
  repo: GitRepoRef,
  pull: string,
  token: string | undefined,
  isSettled: (payload: unknown) => boolean,
  options: { delayFirst?: boolean; intervalMs: number; maxAttempts: number },
  fetcher: PlainFetch = githubFetch
): Promise<unknown> {
  let payload: unknown;
  for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
    if (attempt > 0 || options.delayFirst === true) {
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    }
    payload = await fetchPullData(repo, pull, token, fetcher);
    if (isSettled(payload)) {
      break;
    }
  }
  return payload;
}

// Reads pulls/{n}, re-reading briefly (about two seconds) while GitHub is
// still computing `mergeable`. Returns the last payload either way.
// `afterUnknownRead` is for callers that just saw it unknown: the first read
// then waits one interval too, rather than repeating that answer.
export function pollPullMergeable(
  repo: GitRepoRef,
  pull: string,
  token: string | undefined,
  { afterUnknownRead = false }: { afterUnknownRead?: boolean } = {}
): Promise<unknown> {
  return pollPullData(
    repo,
    pull,
    token,
    (payload) => readPullMergeable(payload) != null,
    { delayFirst: afterUnknownRead, intervalMs: 800, maxAttempts: 3 }
  );
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
  fetcher: PlainFetch = githubFetch
): Promise<void> {
  await pollPullData(
    repo,
    pull,
    token,
    (payload) =>
      readStringPath(payload, ['head', 'sha']) === expectedHeadSha &&
      readPullMergeable(payload) != null,
    {
      intervalMs: options.intervalMs ?? 750,
      maxAttempts: options.maxAttempts ?? 12,
    },
    fetcher
  ).catch(() => undefined);
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
