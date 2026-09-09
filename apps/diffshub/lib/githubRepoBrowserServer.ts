import {
  commitErrorResponse,
  fetchGitHubJSON,
  GitHubCommitError,
  readStringPath,
  repoPath,
} from './githubCommitServer';
import { fetchGitHubFileContents } from './githubDiffFileServer';
import {
  encodePath,
  encodeURLSegment,
  type GitHubRepo,
} from './githubDiffSource';
import {
  createGitHubAPIURL,
  createGitHubJSONHeaders,
  getGitHubEnvironment,
} from './githubEnvironment';
import { createJSONResponse } from './jsonResponse';
import {
  type RepoFileData,
  type RepoRefSplit,
  type RepoTreeData,
  splitKnownRepoRef,
} from './repoBrowser';
import { createAsyncLRU, credentialCacheScope } from './serverLRU';

// Server side of the repo file browser: resolves a `ref/path` URL remainder
// against the repository (disambiguating slash-containing branch names via
// the refs API), lists the tree at the resolved commit, and fetches file
// contents.

interface RepoBrowserOptions {
  token: string | undefined;
}

// Files past this size get an error instead of contents — the viewer
// tokenizes the whole file, and multi-megabyte payloads freeze it.
const MAX_FILE_BYTES = 5_000_000;
const FILE_TOO_LARGE_MESSAGE = 'This file is too large to display.';
const REF_CACHE_TTL_MS = 60 * 1000;
const TREE_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_REF_CACHE_ENTRIES = 256;
const MAX_TREE_CACHE_ENTRIES = 64;
const MAX_TREE_CACHE_BYTES = 32 * 1024 * 1024;

interface ResolvedTreeTarget {
  path: string;
  ref: string;
  sha: string;
}

interface CachedTree {
  paths: string[];
  truncated: boolean;
}

const resolvedTreeTargetCache = createAsyncLRU<string, ResolvedTreeTarget>({
  maxEntries: MAX_REF_CACHE_ENTRIES,
  ttlMs: REF_CACHE_TTL_MS,
});
const treeCache = createAsyncLRU<string, CachedTree>({
  maxEntries: MAX_TREE_CACHE_ENTRIES,
  maxWeight: MAX_TREE_CACHE_BYTES,
  ttlMs: TREE_CACHE_TTL_MS,
  weight: (tree) =>
    tree.paths.reduce((total, path) => total + path.length * 2, 0),
});

// Extracts the owner/repo pair every repo-browser route requires, or the 400
// response to return when either is missing.
export function readRepoParams(
  params: URLSearchParams
): { owner: string; repo: string } | Response {
  const owner = params.get('owner');
  const repo = params.get('repo');
  if (owner == null || owner === '' || repo == null || repo === '') {
    return createJSONResponse(
      { error: 'owner and repo parameters are required.' },
      { status: 400 }
    );
  }
  return { owner, repo };
}

// Maps repo-browser failures onto the JSON error response both routes return:
// GitHubCommitError keeps GitHub's own status, anything else (raw-host
// fetches, oversized files) reads as a 502 with the message intact.
export function repoBrowserErrorResponse(error: unknown): Response {
  if (error instanceof GitHubCommitError) {
    return commitErrorResponse(error);
  }
  return createJSONResponse(
    {
      error: error instanceof Error ? error.message : 'GitHub request failed.',
    },
    { status: 502 }
  );
}

export async function loadRepoBrowserTree(
  repo: GitHubRepo,
  refAndPath: string,
  options: RepoBrowserOptions
): Promise<RepoTreeData> {
  const cacheScope = credentialCacheScope(options.token);
  const target = await resolvedTreeTargetCache.getOrCreate(
    `${cacheScope}\0${repo.owner}/${repo.repo}\0${refAndPath}`,
    async () => {
      const split =
        splitKnownRepoRef(refAndPath) ??
        (await splitRefAgainstRepo(repo, refAndPath, options));
      // An empty ref means the default branch: its name and HEAD's sha come
      // from independent endpoints, so resolve them in parallel.
      const [ref, sha] =
        split.ref === ''
          ? await Promise.all([
              fetchDefaultBranch(repo, options),
              resolveCommitSha(repo, 'HEAD', options),
            ])
          : [
              split.ref,
              // Even a full commit SHA must be resolved upstream once per
              // short-lived target-cache window. The SHA makes the tree
              // immutable, but it does not prove that this credential may
              // still read the repository.
              await resolveCommitSha(repo, split.ref, options),
            ];
      return { path: split.path, ref, sha };
    }
  );
  const cachedTree = await treeCache.getOrCreate(
    `${cacheScope}\0${repo.owner}/${repo.repo}\0${target.sha}`,
    async () => {
      const data = await fetchGitHubJSON(
        repoPath(
          repo,
          `/git/trees/${encodeURLSegment(target.sha)}?recursive=1`
        ),
        options.token
      );
      const entries =
        typeof data === 'object' && data != null
          ? (data as Record<string, unknown>).tree
          : undefined;
      const paths: string[] = [];
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          const path = readStringPath(entry, ['path']);
          if (readStringPath(entry, ['type']) === 'blob' && path != null) {
            paths.push(path);
          }
        }
      }
      return {
        paths,
        truncated:
          typeof data === 'object' &&
          data != null &&
          (data as Record<string, unknown>).truncated === true,
      };
    }
  );
  return {
    ...cachedTree,
    path: target.path,
    ref: target.ref,
    sha: target.sha,
  };
}

export async function loadRepoBrowserFile(
  repo: GitHubRepo,
  ref: string,
  file: string,
  options: RepoBrowserOptions
): Promise<RepoFileData> {
  const response = await fetchGitHubFileContents(
    { ...repo, ref },
    file,
    fetch,
    options.token == null
      ? {}
      : { token: options.token, tokenFromRequest: true }
  );
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_FILE_BYTES) {
    throw new Error(FILE_TOO_LARGE_MESSAGE);
  }
  const contents = await response.text();
  if (contents.length > MAX_FILE_BYTES) {
    throw new Error(FILE_TOO_LARGE_MESSAGE);
  }
  if (contents.includes('\u0000')) {
    return { binary: true, contents: '' };
  }
  return { binary: false, contents };
}

export function clearGitHubRepoBrowserServerCache(): void {
  resolvedTreeTargetCache.clear();
  treeCache.clear();
}

// Branch names may contain slashes, which the URL cannot distinguish from
// the path. Ask the refs API for every branch (then tag) sharing the first
// segment's prefix and take the longest one that prefixes the remainder —
// the same greedy resolution the GitHub web UI applies.
async function splitRefAgainstRepo(
  repo: GitHubRepo,
  refAndPath: string,
  options: RepoBrowserOptions
): Promise<RepoRefSplit> {
  for (const namespace of ['heads', 'tags']) {
    const match = await findLongestMatchingRef(
      repo,
      namespace,
      refAndPath,
      options
    );
    if (match != null) {
      return match;
    }
  }
  // No ref matched; let the first segment fail downstream with GitHub's own
  // error rather than guessing further.
  const first = refAndPath.split('/', 1)[0];
  return {
    ref: first,
    path: refAndPath.slice(first.length + 1),
  };
}

async function findLongestMatchingRef(
  repo: GitHubRepo,
  namespace: string,
  refAndPath: string,
  options: RepoBrowserOptions
): Promise<RepoRefSplit | null> {
  const first = refAndPath.split('/', 1)[0];
  const data = await fetchGitHubJSON(
    repoPath(repo, `/git/matching-refs/${encodePath(`${namespace}/${first}`)}`),
    options.token
  );
  if (!Array.isArray(data)) {
    return null;
  }
  let best: string | null = null;
  for (const entry of data) {
    const fullRef = readStringPath(entry, ['ref']);
    if (fullRef == null) {
      continue;
    }
    const name = fullRef.replace(`refs/${namespace}/`, '');
    const matches = refAndPath === name || refAndPath.startsWith(`${name}/`);
    if (matches && (best == null || name.length > best.length)) {
      best = name;
    }
  }
  if (best == null) {
    return null;
  }
  return { ref: best, path: refAndPath.slice(best.length + 1) };
}

// Also consumed by the /api/github-refs listing, which reports the default
// branch alongside the branch and tag names.
export async function fetchDefaultBranch(
  repo: GitHubRepo,
  options: RepoBrowserOptions
): Promise<string> {
  const data = await fetchGitHubJSON(repoPath(repo, ''), options.token);
  const branch = readStringPath(data, ['default_branch']);
  if (branch == null || branch === '') {
    throw new GitHubCommitError(
      `GitHub repo ${repo.owner}/${repo.repo} has no default branch.`,
      'github',
      502
    );
  }
  return branch;
}

async function resolveCommitSha(
  repo: GitHubRepo,
  ref: string,
  options: RepoBrowserOptions
): Promise<string> {
  // Fully-qualified refs (refs/pull/41/head) go through the git refs API.
  if (ref.startsWith('refs/')) {
    const data = await fetchGitHubJSON(
      repoPath(repo, `/git/ref/${encodePath(ref.slice('refs/'.length))}`),
      options.token
    );
    const sha = readStringPath(data, ['object', 'sha']);
    if (sha == null || sha === '') {
      throw new GitHubCommitError(
        `GitHub ref ${repo.owner}/${repo.repo}@${ref} did not resolve to a commit.`,
        'github',
        502
      );
    }
    return sha;
  }
  // Branch, tag, and sha names all resolve through the commits API. The sha
  // media type returns the bare commit sha; the default JSON representation
  // would carry the whole patch payload.
  const response = await fetch(
    createGitHubAPIURL(
      getGitHubEnvironment(),
      repoPath(repo, `/commits/${encodeURLSegment(ref)}`)
    ),
    {
      headers: {
        ...createGitHubJSONHeaders(options.token),
        Accept: 'application/vnd.github.sha',
      },
      cache: 'no-store',
    }
  );
  if (!response.ok) {
    throw new GitHubCommitError(
      `GitHub ref ${repo.owner}/${repo.repo}@${ref} did not resolve to a commit.`,
      'github',
      response.status
    );
  }
  return (await response.text()).trim();
}
