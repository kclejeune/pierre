import type { PullRefs } from './githubCommitServer';
import {
  buildHeaders,
  pullParams,
  type PullRequestRef,
  requestJSON,
} from './pullCommentsClient';
import type { PullMergeMethod } from './pullMergeClient';

// A label on the pull request; `color` is GitHub's 6-digit hex without '#'.
export interface PullLabel {
  color: string;
  name: string;
}

// Where a reviewer stands: the latest submitted review verdict, or PENDING
// for a requested reviewer who has not reviewed yet.
export type PullReviewerState =
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'COMMENTED'
  | 'PENDING';

export interface PullReviewer {
  avatarUrl?: string;
  login: string;
  state: PullReviewerState;
}

// One CI signal on the head commit (a check run or a legacy commit status),
// normalized to the states the UI distinguishes.
export type PullCheckState = 'failure' | 'neutral' | 'pending' | 'success';

export interface PullCheck {
  detailsUrl?: string;
  name: string;
  state: PullCheckState;
}

export interface PullMergeCapabilities {
  canMerge: boolean;
  methods: PullMergeMethod[];
}

export interface PullDetailsSupplement {
  checks: PullCheck[] | null;
  mergeCapabilities: PullMergeCapabilities | null;
  reviewers: PullReviewer[] | null;
}

// The pull request metadata the details panel shows beyond refs. `checks` is
// null until the lazy supplement loads, or when CI could not be loaded.
export interface PullDetails {
  authorLogin?: string;
  body: string;
  checks: PullCheck[] | null;
  draft: boolean;
  labels: PullLabel[];
  // GitHub computes mergeability lazily; null means still unknown.
  mergeable: boolean | null;
  mergeableState: string | null;
  reviewers: PullReviewer[];
  state: 'closed' | 'merged' | 'open';
  title: string;
}

// The pull's base/head branches (with their repositories, which differ for
// fork pulls) plus display metadata, tagged with the pull number so a stale
// response for another pull is recognizable after navigation. `details` is
// optional so older cached responses stay parseable.
export type PullInfo = PullRefs & { details?: PullDetails; number: string };

// Client wrapper for /api/pull-info, for chrome that labels what the loaded
// diff compares and the header's pull-details panel.
export async function fetchPullInfo(
  pull: PullRequestRef,
  token: string | undefined,
  signal?: AbortSignal
): Promise<PullInfo> {
  const payload = await requestJSON(`/api/pull-info?${pullParams(pull)}`, {
    headers: buildHeaders(token),
    signal,
  });
  return payload as PullInfo;
}

export async function fetchPullDetailsSupplement(
  pull: PullRequestRef,
  headSha: string,
  token: string | undefined,
  signal?: AbortSignal
): Promise<PullDetailsSupplement> {
  const params = pullParams(pull);
  params.set('head', headSha);
  const payload = await requestJSON(`/api/pull-details?${params}`, {
    headers: buildHeaders(token),
    signal,
  });
  return payload as PullDetailsSupplement;
}

export function mergePullReviewers(
  requested: readonly PullReviewer[],
  submitted: readonly PullReviewer[] | null
): PullReviewer[] {
  if (submitted == null) {
    return [...requested];
  }
  const submittedByLogin = new Map(
    submitted.map((reviewer) => [reviewer.login, reviewer])
  );
  const merged = requested.map((reviewer) => {
    const verdict = submittedByLogin.get(reviewer.login);
    if (verdict == null) {
      return reviewer;
    }
    submittedByLogin.delete(reviewer.login);
    return {
      ...verdict,
      avatarUrl: reviewer.avatarUrl ?? verdict.avatarUrl,
    };
  });
  merged.push(...submittedByLogin.values());
  return merged;
}
