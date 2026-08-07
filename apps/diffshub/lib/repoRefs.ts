import type { GitHubRepo } from './githubDiffSource';
import { buildHeaders, requestJSON } from './pullCommentsClient';

// Shared shapes for the /browse dashboard's ref listing: the branch and tag
// names of a repository, served by the /api/github-refs route.

export interface RepoRefsData {
  defaultBranch: string;
  // Ordered default branch first by the server.
  branches: string[];
  tags: string[];
  // True when either list was cut at the API page size (very large repos);
  // the free-form ref input still reaches anything not listed.
  truncated: boolean;
}

// In-flight/completed responses keyed per repo+token, so the dashboard and
// the tree view's diff menu share one fetch instead of re-running the
// three-request fan-out on every mount (the route itself is no-store).
// Failures evict so the next attempt retries.
const refsCache = new Map<string, Promise<RepoRefsData>>();

export function fetchRepoRefs(
  repo: GitHubRepo,
  token: string | undefined
): Promise<RepoRefsData> {
  const key = `${token ?? ''}:${repo.owner}/${repo.repo}`;
  let pending = refsCache.get(key);
  if (pending == null) {
    const params = new URLSearchParams({ owner: repo.owner, repo: repo.repo });
    pending = requestJSON(`/api/github-refs?${params}`, {
      headers: buildHeaders(token),
    }) as Promise<RepoRefsData>;
    refsCache.set(key, pending);
    pending.catch(() => refsCache.delete(key));
  }
  return pending;
}
