// Server-side assembly of the pull-details payload: parsing the display
// metadata out of a pulls/{n} response and fetching the two companion
// listings it does not carry — submitted reviews (who approved / requested
// changes) and CI signals on the head commit. The parsing and folding
// helpers are pure so they stay unit-testable without network.

import {
  fetchGitHubJSON,
  type GitRepoRef,
  repoPath,
} from './githubCommitServer';
import { encodeURLSegment } from './githubDiffSource';
import type {
  PullCheck,
  PullCheckState,
  PullDetails,
  PullLabel,
  PullReviewer,
  PullReviewerState,
} from './pullInfoClient';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value != null
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(value: unknown, key: string): string | undefined {
  const record = asRecord(value);
  const field = record?.[key];
  return typeof field === 'string' ? field : undefined;
}

// The metadata a pulls/{n} payload carries directly. Reviewers start as the
// still-pending requested users/teams; mergeReviewerStates folds submitted
// reviews on top.
export function parsePullDetails(data: unknown): Omit<PullDetails, 'checks'> {
  const record = asRecord(data) ?? {};
  const labels: PullLabel[] = [];
  if (Array.isArray(record.labels)) {
    for (const label of record.labels) {
      const name = stringField(label, 'name');
      if (name != null) {
        labels.push({ color: stringField(label, 'color') ?? '', name });
      }
    }
  }
  const reviewers: PullReviewer[] = [];
  if (Array.isArray(record.requested_reviewers)) {
    for (const user of record.requested_reviewers) {
      const login = stringField(user, 'login');
      if (login != null) {
        reviewers.push({
          avatarUrl: stringField(user, 'avatar_url'),
          login,
          state: 'PENDING',
        });
      }
    }
  }
  // Requested teams review as a unit; surface them by slug with no avatar.
  if (Array.isArray(record.requested_teams)) {
    for (const team of record.requested_teams) {
      const slug = stringField(team, 'slug') ?? stringField(team, 'name');
      if (slug != null) {
        reviewers.push({ login: slug, state: 'PENDING' });
      }
    }
  }
  return {
    authorLogin: stringField(record.user, 'login'),
    body: typeof record.body === 'string' ? record.body : '',
    draft: record.draft === true,
    labels,
    mergeable: typeof record.mergeable === 'boolean' ? record.mergeable : null,
    mergeableState:
      typeof record.mergeable_state === 'string'
        ? record.mergeable_state
        : null,
    reviewers,
    state:
      record.merged_at != null
        ? 'merged'
        : record.state === 'closed'
          ? 'closed'
          : 'open',
    title: typeof record.title === 'string' ? record.title : '',
  };
}

// Folds a reviews listing (chronological) into the latest standing verdict
// per reviewer: APPROVED and CHANGES_REQUESTED replace earlier states, a
// COMMENTED review only fills in for reviewers with no verdict yet, and a
// DISMISSED entry clears the verdict back to COMMENTED. Unsubmitted PENDING
// reviews are private to their author and are skipped.
export function foldReviewStates(
  reviews: unknown
): Map<string, { avatarUrl?: string; state: PullReviewerState }> {
  const states = new Map<
    string,
    { avatarUrl?: string; state: PullReviewerState }
  >();
  if (!Array.isArray(reviews)) {
    return states;
  }
  for (const review of reviews) {
    const record = asRecord(review);
    const login = stringField(record?.user, 'login');
    const state = record?.state;
    if (login == null || typeof state !== 'string' || state === 'PENDING') {
      continue;
    }
    const avatarUrl = stringField(record?.user, 'avatar_url');
    const current = states.get(login);
    if (state === 'APPROVED' || state === 'CHANGES_REQUESTED') {
      states.set(login, { avatarUrl, state });
    } else if (state === 'DISMISSED' || current == null) {
      states.set(login, { avatarUrl, state: 'COMMENTED' });
    }
  }
  return states;
}

// Overlays submitted review verdicts onto the requested-reviewer list:
// requested reviewers keep PENDING unless they since reviewed, and everyone
// who reviewed without being (re-)requested is appended.
export function mergeReviewerStates(
  requested: readonly PullReviewer[],
  reviewStates: ReadonlyMap<
    string,
    { avatarUrl?: string; state: PullReviewerState }
  >
): PullReviewer[] {
  const merged: PullReviewer[] = requested.map((reviewer) => {
    const reviewed = reviewStates.get(reviewer.login);
    return reviewed == null
      ? reviewer
      : {
          avatarUrl: reviewer.avatarUrl ?? reviewed.avatarUrl,
          login: reviewer.login,
          state: reviewed.state,
        };
  });
  const requestedLogins = new Set(requested.map((r) => r.login));
  for (const [login, reviewed] of reviewStates) {
    if (!requestedLogins.has(login)) {
      merged.push({
        avatarUrl: reviewed.avatarUrl,
        login,
        state: reviewed.state,
      });
    }
  }
  return merged;
}

// One check run from the checks API, normalized: a completed run's
// conclusion decides success/failure/neutral, anything not yet completed is
// pending.
export function normalizeCheckRun(run: unknown): PullCheck | null {
  const record = asRecord(run);
  const name = stringField(record, 'name');
  if (record == null || name == null) {
    return null;
  }
  let state: PullCheckState;
  if (record.status !== 'completed') {
    state = 'pending';
  } else if (record.conclusion === 'success') {
    state = 'success';
  } else if (
    record.conclusion === 'neutral' ||
    record.conclusion === 'skipped'
  ) {
    state = 'neutral';
  } else {
    // failure, timed_out, cancelled, action_required, stale.
    state = 'failure';
  }
  return {
    detailsUrl: stringField(record, 'html_url'),
    name,
    state,
  };
}

// One legacy commit status, normalized to the same states.
export function normalizeCommitStatus(status: unknown): PullCheck | null {
  const record = asRecord(status);
  const name = stringField(record, 'context');
  if (record == null || name == null) {
    return null;
  }
  const state: PullCheckState =
    record.state === 'success'
      ? 'success'
      : record.state === 'pending'
        ? 'pending'
        : 'failure'; // failure or error.
  return {
    detailsUrl: stringField(record, 'target_url'),
    name,
    state,
  };
}

// The latest submitted review verdict per reviewer, from the pull's reviews
// listing (first 100 reviews — enough for the verdict fold in practice).
export async function fetchPullReviewStates(
  repo: GitRepoRef,
  pull: string,
  token: string | undefined
): Promise<Map<string, { avatarUrl?: string; state: PullReviewerState }>> {
  const payload = await fetchGitHubJSON(
    repoPath(repo, `/pulls/${encodeURLSegment(pull)}/reviews?per_page=100`),
    token
  );
  return foldReviewStates(payload);
}

// Every CI signal on the head commit: modern check runs plus legacy commit
// statuses (both APIs are still in active use), first 100 of each.
export async function fetchPullChecks(
  repo: GitRepoRef,
  headSha: string,
  token: string | undefined
): Promise<PullCheck[]> {
  const [checkRunsPayload, statusPayload] = await Promise.all([
    fetchGitHubJSON(
      repoPath(
        repo,
        `/commits/${encodeURLSegment(headSha)}/check-runs?per_page=100`
      ),
      token
    ),
    fetchGitHubJSON(
      repoPath(repo, `/commits/${encodeURLSegment(headSha)}/status`),
      token
    ),
  ]);
  const checks: PullCheck[] = [];
  const runs = asRecord(checkRunsPayload)?.check_runs;
  if (Array.isArray(runs)) {
    for (const run of runs) {
      const check = normalizeCheckRun(run);
      if (check != null) {
        checks.push(check);
      }
    }
  }
  const statuses = asRecord(statusPayload)?.statuses;
  if (Array.isArray(statuses)) {
    for (const status of statuses) {
      const check = normalizeCommitStatus(status);
      if (check != null) {
        checks.push(check);
      }
    }
  }
  return checks;
}
