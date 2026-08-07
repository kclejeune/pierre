import {
  fetchGitHubJSON,
  readStringPath,
  repoPath,
} from './githubCommitServer';
import type { GitHubRepo } from './githubDiffSource';
import { fetchDefaultBranch } from './githubRepoBrowserServer';
import type { RepoRefsData } from './repoRefs';

// Server side of the /browse dashboard's ref listing: the repository's
// default branch plus its branch and tag names, one page of each. A single
// page keeps the route to three requests; repos with more refs than that
// still resolve anything typed into the free-form ref input.

interface RepoRefsOptions {
  token: string | undefined;
}

const REFS_PAGE_SIZE = 100;

export async function loadRepoRefs(
  repo: GitHubRepo,
  options: RepoRefsOptions
): Promise<RepoRefsData> {
  const [defaultBranch, branchData, tagData] = await Promise.all([
    fetchDefaultBranch(repo, options),
    fetchGitHubJSON(
      repoPath(repo, `/branches?per_page=${REFS_PAGE_SIZE}`),
      options.token
    ),
    fetchGitHubJSON(
      repoPath(repo, `/tags?per_page=${REFS_PAGE_SIZE}`),
      options.token
    ),
  ]);
  const listedBranches = readNames(branchData);
  const tags = readNames(tagData);
  return {
    defaultBranch,
    // Default branch first — the ordering every consumer wants, established
    // once here rather than re-derived per view. GitHub pages branches
    // alphabetically, so the default may not even be in the listed page.
    branches: [
      defaultBranch,
      ...listedBranches.filter((branch) => branch !== defaultBranch),
    ],
    tags,
    truncated:
      listedBranches.length >= REFS_PAGE_SIZE || tags.length >= REFS_PAGE_SIZE,
  };
}

function readNames(data: unknown): string[] {
  if (!Array.isArray(data)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of data) {
    const name = readStringPath(entry, ['name']);
    if (name != null && name !== '') {
      names.push(name);
    }
  }
  return names;
}
