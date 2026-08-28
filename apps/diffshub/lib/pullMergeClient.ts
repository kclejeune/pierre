import {
  buildHeaders,
  type PullRequestRef,
  requestJSON,
} from './pullCommentsClient';

export type PullMergeMethod = 'merge' | 'rebase' | 'squash';

export interface PullMergeResult {
  message?: string;
  merged: boolean;
  // The resulting merge (or head, for rebases) commit on the base branch.
  sha?: string;
}

// Client wrapper for /api/pull-merge — GitHub's "Merge pull request" button.
// `expectedHeadSha` pins the merge to the head the viewer reviewed; the
// request fails (409, surfaced as APIRequestError) if the branch moved.
export async function mergePullRequest(
  pull: PullRequestRef,
  token: string,
  method: PullMergeMethod,
  expectedHeadSha?: string
): Promise<PullMergeResult> {
  const payload = await requestJSON('/api/pull-merge', {
    body: JSON.stringify({
      expectedHeadSha,
      method,
      owner: pull.owner,
      pull: pull.number,
      repo: pull.repo,
    }),
    headers: { ...buildHeaders(token), 'Content-Type': 'application/json' },
    method: 'POST',
  });
  return payload as PullMergeResult;
}
