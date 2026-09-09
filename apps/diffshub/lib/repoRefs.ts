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

export function fetchRepoRefs(
  repo: GitHubRepo,
  token: string | undefined
): Promise<RepoRefsData> {
  const params = new URLSearchParams({ owner: repo.owner, repo: repo.repo });
  return requestJSON(`/api/github-refs?${params}`, {
    headers: buildHeaders(token),
  }) as Promise<RepoRefsData>;
}
