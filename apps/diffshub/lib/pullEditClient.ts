import { postPullJSON, type PullRequestRef } from './pullCommentsClient';
import type { PullDetails, PullLabel, PullReviewer } from './pullInfoClient';

export interface PullEditChanges {
  body?: string;
  draft?: boolean;
  state?: 'closed' | 'open';
  title?: string;
}

// Resolves to the pull's details as GitHub reports them after the update.
export async function updatePullRequest(
  pull: PullRequestRef,
  token: string,
  changes: PullEditChanges
): Promise<PullDetails> {
  return (await postPullJSON(
    '/api/pull-edit',
    pull,
    token,
    changes
  )) as PullDetails;
}

// Resolves to the pull's labels after the change.
export async function changePullLabel(
  pull: PullRequestRef,
  token: string,
  action: 'add' | 'remove',
  label: string
): Promise<PullLabel[]> {
  const payload = await postPullJSON('/api/pull-labels', pull, token, {
    action,
    label,
  });
  return (payload as { labels: PullLabel[] }).labels;
}

// Requests (add) or withdraws (remove) one user's review on the pull.
// Resolves to the pull's pending review requests after the change, users and
// teams, in the shape PullDetails.reviewers holds them.
export async function changePullReviewer(
  pull: PullRequestRef,
  token: string,
  action: 'add' | 'remove',
  login: string
): Promise<PullReviewer[]> {
  const payload = await postPullJSON('/api/pull-reviewers', pull, token, {
    action,
    login,
  });
  return (payload as { reviewers: PullReviewer[] }).reviewers;
}
