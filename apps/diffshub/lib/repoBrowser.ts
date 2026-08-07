import { encodePath, type GitHubRepo } from './githubDiffSource';
import { buildHeaders, requestJSON } from './pullCommentsClient';

// Shared shapes and pure logic for the repo file browser: a plain tree +
// highlighted-file view of a repository at an arbitrary ref, served by the
// /api/github-tree and /api/github-file routes.

// The listing for one repository commit, resolved from a `ref/path` URL
// remainder (GitHub's tree/blob URL grammar).
export interface RepoTreeData {
  // Display name of the resolved ref (branch, tag, refs/pull/…, or sha).
  ref: string;
  // The resolved commit sha. File fetches use this instead of the ref name so
  // the contents always match the listing even if the branch moves.
  sha: string;
  // The path remainder inside the ref, '' at the repository root.
  path: string;
  // Every blob path at the commit.
  paths: string[];
  // True when GitHub truncated the recursive tree listing (very large repos).
  truncated: boolean;
}

export interface RepoFileData {
  contents: string;
  // True when the file is not renderable text; contents is empty then.
  binary: boolean;
}

export interface RepoRefSplit {
  ref: string;
  path: string;
}

const PULL_REF_PATTERN = /^(refs\/pull\/\d+\/(?:head|merge))(?:\/(.*))?$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

// The advertised head ref of a pull request — the form PULL_REF_PATTERN
// above splits without asking the repository, so links built with it resolve
// client-side for free.
export function formatPullHeadRef(number: string): string {
  return `refs/pull/${number}/head`;
}

// App-relative browse URLs. The grammar deliberately mirrors GitHub's own
// /owner/repo/{tree,blob}/{ref}/{path} shape, so prefixing the instance's
// webURL onto the same path yields the matching GitHub link.
export function buildBrowseBlobPath(
  repo: GitHubRepo,
  ref: string,
  path: string
): string {
  return `/${encodePath(`${repo.owner}/${repo.repo}`)}/blob/${encodePath(ref)}/${encodePath(path)}`;
}

export function buildBrowseTreePath(repo: GitHubRepo, ref: string): string {
  return `/${encodePath(`${repo.owner}/${repo.repo}`)}/tree/${encodePath(ref)}`;
}

// Splits a `ref/path` URL remainder when the ref's shape is recognizable
// without the repository's ref list: the empty root, pull refs, sha-like
// first segments, and single-segment refs. Branch names containing slashes
// are ambiguous against the path and return null — the server disambiguates
// those against the repo's actual refs.
export function splitKnownRepoRef(refAndPath: string): RepoRefSplit | null {
  if (refAndPath === '') {
    return { ref: '', path: '' };
  }
  const pullMatch = PULL_REF_PATTERN.exec(refAndPath);
  if (pullMatch != null) {
    return { ref: pullMatch[1], path: pullMatch[2] ?? '' };
  }
  const separator = refAndPath.indexOf('/');
  if (separator === -1) {
    return { ref: refAndPath, path: '' };
  }
  const first = refAndPath.slice(0, separator);
  if (COMMIT_SHA_PATTERN.test(first)) {
    return { ref: first, path: refAndPath.slice(separator + 1) };
  }
  return null;
}

// Browser-side wrappers over the repo-browser API routes. All failures throw
// an Error whose message is already user-presentable.
export async function fetchRepoTree(
  repo: GitHubRepo,
  refAndPath: string,
  token: string | undefined,
  signal?: AbortSignal
): Promise<RepoTreeData> {
  const params = new URLSearchParams({
    owner: repo.owner,
    ref: refAndPath,
    repo: repo.repo,
  });
  return (await requestJSON(`/api/github-tree?${params}`, {
    headers: buildHeaders(token),
    signal,
  })) as RepoTreeData;
}

export async function fetchRepoFile(
  repo: GitHubRepo,
  ref: string,
  file: string,
  token: string | undefined,
  signal?: AbortSignal
): Promise<RepoFileData> {
  const params = new URLSearchParams({
    file,
    owner: repo.owner,
    ref,
    repo: repo.repo,
  });
  return (await requestJSON(`/api/github-file?${params}`, {
    headers: buildHeaders(token),
    signal,
  })) as RepoFileData;
}
