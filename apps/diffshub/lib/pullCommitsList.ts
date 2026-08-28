// The pull request's commit listing and the range→viewer-path derivation
// behind the header's commit-range picker: pick one commit to see its own
// diff, or a start/end pair to see everything they span as a compare view.

import type { GitHubRepo } from './githubDiffSource';
import {
  buildHeaders,
  pullParams,
  type PullRequestRef,
  requestJSON,
} from './pullCommentsClient';
import { buildCommitDiffPath, buildComparePath } from './repoBrowser';

// One commit of a pull request, oldest first as GitHub lists them.
export interface PullCommitSummary {
  authorAvatarUrl?: string;
  authorLogin?: string;
  authoredAt?: string;
  // First line of the commit message.
  headline: string;
  // First parent, absent only for a root commit.
  parentSha?: string;
  sha: string;
}

// Client wrapper for /api/pull-commits.
export async function fetchPullCommitsList(
  pull: PullRequestRef,
  token: string | undefined,
  signal?: AbortSignal
): Promise<PullCommitSummary[]> {
  const payload = await requestJSON(`/api/pull-commits?${pullParams(pull)}`, {
    headers: buildHeaders(token),
    signal,
  });
  const commits = (payload as { commits?: PullCommitSummary[] }).commits;
  return Array.isArray(commits) ? commits : [];
}

// The viewer path showing exactly the changes the selected commits span: one
// commit's own diff, or a compare from the earliest selection's parent to
// the latest selection. Selection order does not matter — endpoints
// normalize to listing order. Null when a sha is not in the listing or the
// earliest selection is a root commit (no parent to diff from).
export function commitRangeViewerPath(
  repo: GitHubRepo,
  commits: readonly PullCommitSummary[],
  selectedShaA: string,
  selectedShaB: string
): string | null {
  const indexA = commits.findIndex((commit) => commit.sha === selectedShaA);
  const indexB = commits.findIndex((commit) => commit.sha === selectedShaB);
  if (indexA < 0 || indexB < 0) {
    return null;
  }
  const start = commits[Math.min(indexA, indexB)];
  const end = commits[Math.max(indexA, indexB)];
  if (start.sha === end.sha) {
    return buildCommitDiffPath(repo, start.sha);
  }
  if (start.parentSha == null) {
    return null;
  }
  return buildComparePath(repo, start.parentSha, end.sha);
}
