// Server-side assembly of the pull-details payload: parsing the display
// metadata out of a pulls/{n} response and fetching the two companion
// listings it does not carry — submitted reviews (who approved / requested
// changes) and CI signals on the head commit. The parsing and folding
// helpers are pure so they stay unit-testable without network.

import {
  fetchGitHubJSON,
  type GitRepoRef,
  readStringPath,
  repoPath,
} from './githubCommitServer';
import { encodeURLSegment } from './githubDiffSource';
import { createJSONResponse } from './jsonResponse';
import type { PullCommitSummary } from './pullCommitsList';
import type {
  PullCheck,
  PullCheckState,
  PullDetails,
  PullLabel,
  PullReviewer,
  PullReviewerState,
} from './pullInfoClient';
import { asRecord } from './untypedJson';

// Parses the owner/repo/pull query params the pull-scoped API routes share,
// or the 400 response for a missing/malformed set.
export function readPullRouteParams(
  params: URLSearchParams
): { owner: string; repo: string; pull: string } | Response {
  const owner = params.get('owner');
  const repo = params.get('repo');
  const pull = params.get('pull');
  if (owner == null || repo == null || pull == null || !/^\d+$/.test(pull)) {
    return createJSONResponse(
      { error: 'owner, repo, and pull are required.' },
      { status: 400 }
    );
  }
  return { owner, pull, repo };
}

// The metadata a pulls/{n} payload carries directly. Reviewers start as the
// still-pending requested users/teams; mergeReviewerStates folds submitted
// reviews on top.
export function parsePullDetails(data: unknown): Omit<PullDetails, 'checks'> {
  const record = asRecord(data) ?? {};
  const labels: PullLabel[] = [];
  if (Array.isArray(record.labels)) {
    for (const label of record.labels) {
      const name = readStringPath(label, ['name']);
      if (name != null) {
        labels.push({ color: readStringPath(label, ['color']) ?? '', name });
      }
    }
  }
  const reviewers: PullReviewer[] = [];
  if (Array.isArray(record.requested_reviewers)) {
    for (const user of record.requested_reviewers) {
      const login = readStringPath(user, ['login']);
      if (login != null) {
        reviewers.push({
          avatarUrl: readStringPath(user, ['avatar_url']),
          login,
          state: 'PENDING',
        });
      }
    }
  }
  // Requested teams review as a unit; surface them by slug with no avatar.
  if (Array.isArray(record.requested_teams)) {
    for (const team of record.requested_teams) {
      const slug =
        readStringPath(team, ['slug']) ?? readStringPath(team, ['name']);
      if (slug != null) {
        reviewers.push({ login: slug, state: 'PENDING' });
      }
    }
  }
  return {
    authorLogin: readStringPath(record.user, ['login']),
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
    const login = readStringPath(record?.user, ['login']);
    const state = record?.state;
    if (login == null || typeof state !== 'string' || state === 'PENDING') {
      continue;
    }
    const avatarUrl = readStringPath(record?.user, ['avatar_url']);
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
  const name = readStringPath(record, ['name']);
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
    detailsUrl: readStringPath(record, ['html_url']),
    name,
    state,
  };
}

// One legacy commit status, normalized to the same states.
export function normalizeCommitStatus(status: unknown): PullCheck | null {
  const record = asRecord(status);
  const name = readStringPath(record, ['context']);
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
    detailsUrl: readStringPath(record, ['target_url']),
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

// One page of a pulls/{n}/commits listing, narrowed to what the range
// picker renders: sha, first parent, message headline, author identity.
export function parsePullCommitsPage(payload: unknown): PullCommitSummary[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  const commits: PullCommitSummary[] = [];
  for (const entry of payload) {
    const record = asRecord(entry);
    const sha = readStringPath(record, ['sha']);
    if (record == null || sha == null) {
      continue;
    }
    const commit = asRecord(record.commit);
    const message = readStringPath(commit, ['message']) ?? '';
    const parents = Array.isArray(record.parents) ? record.parents : [];
    commits.push({
      authorAvatarUrl: readStringPath(record.author, ['avatar_url']),
      // The GitHub account when the commit email resolved to one, otherwise
      // the raw commit author name.
      authorLogin:
        readStringPath(record.author, ['login']) ??
        readStringPath(commit?.author, ['name']),
      authoredAt: readStringPath(commit?.author, ['date']),
      headline: message.split('\n', 1)[0],
      parentSha: readStringPath(parents[0], ['sha']),
      sha,
    });
  }
  return commits;
}

// Every commit of the pull request, oldest first. GitHub caps this listing
// at 250 commits, so three 100-per-page requests cover it; single-page pulls
// (the common case) stop after one request, larger ones fetch the remaining
// pages in parallel.
export async function fetchPullCommitsListing(
  repo: GitRepoRef,
  pull: string,
  token: string | undefined
): Promise<PullCommitSummary[]> {
  const fetchPage = async (page: number): Promise<PullCommitSummary[]> =>
    parsePullCommitsPage(
      await fetchGitHubJSON(
        repoPath(
          repo,
          `/pulls/${encodeURLSegment(pull)}/commits?per_page=100&page=${page}`
        ),
        token
      )
    );
  const first = await fetchPage(1);
  if (first.length < 100) {
    return first;
  }
  const rest = await Promise.all([fetchPage(2), fetchPage(3)]);
  const commits = [...first];
  for (const page of rest) {
    commits.push(...page);
    if (page.length < 100) {
      break;
    }
  }
  return commits;
}
