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
// commit's own diff (start === end), or a compare from the start's parent to
// the end. `start` must be the earlier commit in listing order — the picker
// normalizes the selection before calling. Null when the start is a root
// commit (no parent to diff from).
export function commitRangeViewerPath(
  repo: GitHubRepo,
  start: PullCommitSummary,
  end: PullCommitSummary
): string | null {
  if (start.sha === end.sha) {
    return buildCommitDiffPath(repo, start.sha);
  }
  if (start.parentSha == null) {
    return null;
  }
  return buildComparePath(repo, start.parentSha, end.sha);
}
