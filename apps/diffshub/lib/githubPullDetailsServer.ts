// Server-side assembly of the pull-details payload: parsing the display
// metadata out of a pulls/{n} response and fetching the two companion
// listings it does not carry — submitted reviews (who approved / requested
// changes) and CI signals on the head commit. The parsing and folding
// helpers are pure so they stay unit-testable without network.

import {
  type GitRepoRef,
  readStringPath,
  repoPath,
  sendGitHubGraphQL,
} from './githubCommitServer';
import { encodeURLSegment } from './githubDiffSource';
import { githubFetch } from './githubFetch';
import { fetchAllGitHubPages } from './githubPagination';
import { createJSONResponse } from './jsonResponse';
import { isValidGitHubLogin } from './mutedAuthors';
import type { PlainFetch } from './plainFetch';
import type { PullCommitSummary } from './pullCommitsList';
import type {
  PullCheck,
  PullCheckState,
  PullDetails,
  PullLabel,
  PullMergeCapabilities,
  PullMergeQueueStatus,
  PullReviewer,
  PullReviewerState,
  PullViewerPermissions,
  ReviewerCandidate,
} from './pullInfoClient';
import { parseLabels } from './pullLabels';
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
// still-pending requested users/teams; the client's mergePullReviewers
// overlays submitted review verdicts once the supplement loads.
export function parsePullDetails(data: unknown): PullDetails {
  const record = asRecord(data) ?? {};
  const labels = parseLabels(record.labels);
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
        reviewers.push({ login: slug, state: 'PENDING', team: true });
      }
    }
  }
  return {
    authorAvatarUrl: readStringPath(record.user, ['avatar_url']),
    authorLogin: readStringPath(record.user, ['login']),
    body: typeof record.body === 'string' ? record.body : '',
    createdAt: readStringPath(record, ['created_at']),
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

export interface PullBodyRef {
  owner: string;
  pull: string;
  repo: string;
}

// The owner/repo/pull triple of a pull-scoped POST body, or null when any is
// missing or malformed. The body counterpart of readPullRouteParams.
export function readPullBodyRef(
  record: Record<string, unknown> | null
): PullBodyRef | null {
  const owner = record?.owner;
  const repo = record?.repo;
  const pull = record?.pull;
  return typeof owner === 'string' &&
    typeof repo === 'string' &&
    typeof pull === 'string' &&
    /^\d+$/.test(pull)
    ? { owner, pull, repo }
    : null;
}

export interface PullEditRequest extends PullBodyRef {
  body?: string;
  draft?: boolean;
  state?: 'closed' | 'open';
  title?: string;
}

// Validates a /api/pull-edit body. Blank titles are rejected; an empty body
// clears the description.
export function readPullEditRequest(body: unknown): PullEditRequest | null {
  const record = asRecord(body);
  const ref = readPullBodyRef(record);
  const title = record?.title;
  const description = record?.body;
  const state = record?.state;
  const draft = record?.draft;
  if (
    ref == null ||
    (title != null && (typeof title !== 'string' || title.trim() === '')) ||
    (description != null && typeof description !== 'string') ||
    (state != null && state !== 'open' && state !== 'closed') ||
    (draft != null && typeof draft !== 'boolean') ||
    (title == null && description == null && state == null && draft == null)
  ) {
    return null;
  }
  return {
    ...ref,
    ...(typeof title === 'string' ? { title: title.trim() } : {}),
    ...(typeof description === 'string' ? { body: description } : {}),
    ...(state != null ? { state } : {}),
    ...(typeof draft === 'boolean' ? { draft } : {}),
  };
}

export interface PullLabelChange extends PullBodyRef {
  action: 'add' | 'remove';
  label: string;
}

// Validates a /api/pull-labels POST body: one label to add or remove.
export function readPullLabelChange(body: unknown): PullLabelChange | null {
  const record = asRecord(body);
  const ref = readPullBodyRef(record);
  const action = record?.action;
  const label = record?.label;
  if (
    ref == null ||
    (action !== 'add' && action !== 'remove') ||
    typeof label !== 'string' ||
    label === ''
  ) {
    return null;
  }
  return { ...ref, action, label };
}

export interface PullReviewerChange extends PullBodyRef {
  action: 'add' | 'remove';
  login: string;
}

// A /api/pull-reviewers POST body: the pull, add or remove, and one user
// login. Null when any part is missing or the login isn't a valid one.
export function readPullReviewerChange(
  body: unknown
): PullReviewerChange | null {
  const record = asRecord(body);
  const ref = readPullBodyRef(record);
  const action = record?.action;
  const login = record?.login;
  if (
    ref == null ||
    (action !== 'add' && action !== 'remove') ||
    typeof login !== 'string' ||
    !isValidGitHubLogin(login)
  ) {
    return null;
  }
  return { ...ref, action, login };
}

// Users the reviewer picker offers: the repository's assignable users
// matching `query` (login or name), which is GitHub's closest public
// listing to "people who can review here". Bots are left out.
const REVIEWER_CANDIDATES_QUERY = `query ($owner: String!, $name: String!, $query: String!) {
  repository(owner: $owner, name: $name) {
    assignableUsers(first: 20, query: $query) {
      nodes { login name avatarUrl }
    }
  }
}`;

export async function fetchReviewerCandidates(
  repo: GitRepoRef,
  query: string,
  token: string,
  fetcher: PlainFetch = githubFetch
): Promise<ReviewerCandidate[]> {
  const data = await sendGitHubGraphQL(
    REVIEWER_CANDIDATES_QUERY,
    { name: repo.repo, owner: repo.owner, query },
    token,
    fetcher
  );
  return parseReviewerCandidates(data);
}

export function parseReviewerCandidates(data: unknown): ReviewerCandidate[] {
  const nodes = asRecord(
    asRecord(asRecord(data)?.repository)?.assignableUsers
  )?.nodes;
  if (!Array.isArray(nodes)) {
    return [];
  }
  const candidates: ReviewerCandidate[] = [];
  for (const node of nodes) {
    const login = readStringPath(node, ['login']);
    if (login == null) {
      continue;
    }
    const candidate: ReviewerCandidate = { login };
    const avatarUrl = readStringPath(node, ['avatarUrl']);
    if (avatarUrl != null) {
      candidate.avatarUrl = avatarUrl;
    }
    const name = readStringPath(node, ['name']);
    if (name != null && name !== '') {
      candidate.name = name;
    }
    candidates.push(candidate);
  }
  return candidates;
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

// The latest submitted review verdict per reviewer. GitHub returns reviews in
// chronological order, so every page must be folded before the result is safe
// to present as current.
export async function fetchPullReviewStates(
  repo: GitRepoRef,
  pull: string,
  token: string | undefined,
  fetcher: PlainFetch = githubFetch
): Promise<Map<string, { avatarUrl?: string; state: PullReviewerState }>> {
  const reviews = await fetchAllGitHubPages(
    (page) =>
      repoPath(
        repo,
        `/pulls/${encodeURLSegment(pull)}/reviews?per_page=100&page=${page}`
      ),
    (payload) => (Array.isArray(payload) ? payload : null),
    token,
    fetcher
  );
  return foldReviewStates(reviews);
}

// Every CI signal on the head commit: modern check runs plus legacy commit
// statuses. The APIs paginate and have different permission behavior, so each
// is exhausted independently and either successful half remains useful.
export async function fetchPullChecks(
  repo: GitRepoRef,
  headSha: string,
  token: string | undefined,
  fetcher: PlainFetch = githubFetch
): Promise<PullCheck[]> {
  const [checkRunsResult, statusesResult] = await Promise.allSettled([
    fetchAllCheckRuns(repo, headSha, token, fetcher),
    fetchAllCommitStatuses(repo, headSha, token, fetcher),
  ]);
  if (
    checkRunsResult.status === 'rejected' &&
    statusesResult.status === 'rejected'
  ) {
    throw checkRunsResult.reason;
  }
  const checks: PullCheck[] = [];
  if (checkRunsResult.status === 'fulfilled') {
    for (const run of checkRunsResult.value) {
      const check = normalizeCheckRun(run);
      if (check != null) {
        checks.push(check);
      }
    }
  }
  if (statusesResult.status === 'fulfilled') {
    for (const status of statusesResult.value) {
      const check = normalizeCommitStatus(status);
      if (check != null) {
        checks.push(check);
      }
    }
  }
  return checks;
}

function fetchAllCheckRuns(
  repo: GitRepoRef,
  headSha: string,
  token: string | undefined,
  fetcher: PlainFetch
): Promise<unknown[]> {
  return fetchAllGitHubPages(
    (page) =>
      repoPath(
        repo,
        `/commits/${encodeURLSegment(headSha)}/check-runs?per_page=100&page=${page}`
      ),
    (payload) => {
      const runs = asRecord(payload)?.check_runs;
      return Array.isArray(runs) ? runs : null;
    },
    token,
    fetcher
  );
}

function fetchAllCommitStatuses(
  repo: GitRepoRef,
  headSha: string,
  token: string | undefined,
  fetcher: PlainFetch
): Promise<unknown[]> {
  return fetchAllGitHubPages(
    (page) =>
      repoPath(
        repo,
        `/commits/${encodeURLSegment(headSha)}/status?per_page=100&page=${page}`
      ),
    (payload) => {
      const statuses = asRecord(payload)?.statuses;
      return Array.isArray(statuses) ? statuses : null;
    },
    token,
    fetcher
  );
}

const MERGE_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

// Reads PULL_ACCESS_QUERY's `data`. GraphQL rather than the REST repo: REST
// includes the allow_*_merge settings only for repo admins, so for everyone
// else no merge method looked enabled; GraphQL exposes them to any reader.
export function parsePullMergeCapabilities(
  data: unknown
): PullMergeCapabilities {
  const repository = asRecord(asRecord(data)?.repository);
  return {
    canMerge: MERGE_PERMISSIONS.has(
      readStringPath(repository, ['viewerPermission']) ?? ''
    ),
    methods: [
      ...(repository?.mergeCommitAllowed === true ? (['merge'] as const) : []),
      ...(repository?.squashMergeAllowed === true ? (['squash'] as const) : []),
      ...(repository?.rebaseMergeAllowed === true ? (['rebase'] as const) : []),
    ],
  };
}

// The pull's merge-queue standing from a GraphQL PullRequest node carrying
// MERGE_QUEUE_FIELDS, or null when its base branch has no queue.
export function parsePullMergeQueueStatus(
  pullRequest: unknown
): PullMergeQueueStatus | null {
  const pull = asRecord(pullRequest);
  if (pull?.isMergeQueueEnabled !== true) {
    return null;
  }
  const entry = asRecord(pull.mergeQueueEntry);
  const position = entry?.position;
  return {
    entry:
      typeof position === 'number'
        ? { position, state: readStringPath(entry, ['state']) ?? 'QUEUED' }
        : null,
    pendingAutoMerge: entry == null && pull.autoMergeRequest != null,
  };
}

// The PullRequest fields parsePullMergeQueueStatus reads.
const MERGE_QUEUE_FIELDS = `isMergeQueueEnabled
    mergeQueueEntry { position state }
    autoMergeRequest { enabledAt }`;

const PULL_MERGE_QUEUE_QUERY = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      mergeStateStatus
      ${MERGE_QUEUE_FIELDS}
    }
  }
}`;

// Merge states in which GitHub would merge the pull now (the set `gh pr
// merge` treats as immediately mergeable): such a pull can join the queue
// directly, while any other needs auto-merge to queue it later.
const READY_MERGE_STATES = new Set(['CLEAN', 'HAS_HOOKS', 'UNSTABLE']);

// The pull's GraphQL node id (which the queue mutations take), its
// merge-queue standing, and whether it can be queued right away, for the
// merge-queue route.
export async function fetchPullMergeQueue(
  repo: GitRepoRef,
  pull: string,
  token: string,
  fetcher: PlainFetch = githubFetch
): Promise<{
  pullId: string | undefined;
  readyToQueue: boolean;
  status: PullMergeQueueStatus | null;
}> {
  const pullRequest = asRecord(
    asRecord(
      asRecord(
        await sendGitHubGraphQL(
          PULL_MERGE_QUEUE_QUERY,
          { name: repo.repo, number: Number(pull), owner: repo.owner },
          token,
          fetcher
        )
      )?.repository
    )?.pullRequest
  );
  return {
    pullId: readStringPath(pullRequest, ['id']),
    readyToQueue: READY_MERGE_STATES.has(
      readStringPath(pullRequest, ['mergeStateStatus']) ?? ''
    ),
    status: parsePullMergeQueueStatus(pullRequest),
  };
}

// Triage access or above: enough to label a pull and request reviewers.
const TRIAGE_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'TRIAGE', 'WRITE']);

// GitHub's own answer to what the viewer may change on this pull, rather than
// re-deriving its author-or-push-access rules on the client.
export function parsePullViewerPermissions(
  data: unknown
): PullViewerPermissions {
  const repository = asRecord(asRecord(data)?.repository);
  const triage = TRIAGE_PERMISSIONS.has(
    readStringPath(repository, ['viewerPermission']) ?? ''
  );
  return {
    canLabel: triage,
    canRequestReviews: triage,
    canUpdate: asRecord(repository?.pullRequest)?.viewerCanUpdate === true,
  };
}

// One request for what the viewer may change on the pull, how it may be
// merged, and where it stands in a merge queue.
const PULL_ACCESS_QUERY = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    viewerPermission
    mergeCommitAllowed
    squashMergeAllowed
    rebaseMergeAllowed
    pullRequest(number: $number) {
      viewerCanUpdate
      ${MERGE_QUEUE_FIELDS}
    }
  }
}`;

export async function fetchPullAccess(
  repo: GitRepoRef,
  pull: string,
  token: string,
  fetcher: PlainFetch = githubFetch
): Promise<{
  mergeCapabilities: PullMergeCapabilities;
  mergeQueue: PullMergeQueueStatus | null;
  viewerPermissions: PullViewerPermissions;
}> {
  const data = await sendGitHubGraphQL(
    PULL_ACCESS_QUERY,
    { name: repo.repo, number: Number(pull), owner: repo.owner },
    token,
    fetcher
  );
  return {
    mergeCapabilities: parsePullMergeCapabilities(data),
    mergeQueue: parsePullMergeQueueStatus(
      asRecord(asRecord(data)?.repository)?.pullRequest
    ),
    viewerPermissions: parsePullViewerPermissions(data),
  };
}

export async function fetchRepoLabels(
  repo: GitRepoRef,
  token: string | undefined,
  fetcher: PlainFetch = githubFetch
): Promise<PullLabel[]> {
  return parseLabels(
    await fetchAllGitHubPages(
      (page) => repoPath(repo, `/labels?per_page=100&page=${page}`),
      (payload) => (Array.isArray(payload) ? payload : null),
      token,
      fetcher
    )
  );
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
// at 250 commits, so at most three 100-per-page requests; single-page pulls
// (the common case) stop after one.
export async function fetchPullCommitsListing(
  repo: GitRepoRef,
  pull: string,
  token: string | undefined
): Promise<PullCommitSummary[]> {
  const entries = await fetchAllGitHubPages(
    (page) =>
      repoPath(
        repo,
        `/pulls/${encodeURLSegment(pull)}/commits?per_page=100&page=${page}`
      ),
    (payload) => (Array.isArray(payload) ? payload : null),
    token,
    fetch
  );
  return parsePullCommitsPage(entries);
}
