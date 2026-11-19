import type { PullRefs } from './githubCommitServer';
import {
  discardPrefetch,
  type PrefetchGroup,
  prefetchOnce,
  takeOrLoad,
} from './prefetchStore';
import { pullChangeKey } from './pullChangeEvents';
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

// A user the reviewer picker offers (see /api/pull-reviewers).
export interface ReviewerCandidate {
  avatarUrl?: string;
  login: string;
  name?: string;
}

export interface PullReviewer {
  avatarUrl?: string;
  login: string;
  state: PullReviewerState;
  // A requested team, listed by slug. Teams have no user profile to look up.
  team?: boolean;
}

// One CI signal on the head commit (a check run or a legacy commit status),
// normalized to the states the UI distinguishes.
export type PullCheckState = 'failure' | 'neutral' | 'pending' | 'success';

export interface PullCheck {
  detailsUrl?: string;
  name: string;
  state: PullCheckState;
}

// Where a pull stands in its base branch's merge queue. The queue sets the
// merge method, so a queued branch gets "Merge when ready" instead of the
// method picker.
export interface PullMergeQueueStatus {
  // While queued: the 1-based position and GitHub's MergeQueueEntryState
  // (QUEUED, AWAITING_CHECKS, MERGEABLE, UNMERGEABLE, LOCKED).
  entry: { position: number; state: string } | null;
  // Auto-merge is on but the pull isn't queued yet: GitHub adds it once its
  // required checks pass.
  pendingAutoMerge: boolean;
}

export interface PullMergeCapabilities {
  canMerge: boolean;
  methods: PullMergeMethod[];
}

// canUpdate gates title/body/state/draft edits (author or push access);
// canLabel needs triage access or above.
export interface PullViewerPermissions {
  canLabel: boolean;
  // Request or remove reviewers; triage access or above, like canLabel.
  canRequestReviews: boolean;
  canUpdate: boolean;
}

export interface PullDetailsSupplement {
  checks: PullCheck[] | null;
  mergeCapabilities: PullMergeCapabilities | null;
  // Null when the base branch has no merge queue (or it couldn't be read).
  mergeQueue: PullMergeQueueStatus | null;
  reviewers: PullReviewer[] | null;
  viewerPermissions: PullViewerPermissions | null;
}

// The pull request metadata the details panel shows beyond refs. CI checks,
// review verdicts, and merge capabilities are not here — they arrive via the
// separate PullDetailsSupplement request.
export interface PullDetails {
  authorAvatarUrl?: string;
  authorLogin?: string;
  body: string;
  // ISO timestamp the pull was opened. Optional so cached responses from
  // before the field existed stay parseable.
  createdAt?: string;
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
  signal?: AbortSignal,
  cache: RequestCache = 'default',
  // Asks the route to re-read the pull briefly while GitHub is still
  // computing its mergeability.
  waitMergeable = false
): Promise<PullInfo> {
  const params = pullParams(pull);
  if (waitMergeable) {
    params.set('waitMergeable', '1');
  }
  const url = `/api/pull-info?${params}`;
  const load = async () =>
    (await requestJSON(url, {
      cache,
      headers: buildHeaders(token),
      signal,
    })) as PullInfo;
  // Only the plain read can use a prefetch (lib/prefetchStore). 'reload' and
  // 'no-store' callers want a fresh answer, so any prefetch held for the
  // URL is dropped: it predates their read (an edit's refresh) and a later
  // plain read would otherwise take it. The mergeability re-read has its
  // own URL.
  if (cache === 'default') {
    return takeOrLoad(url, token, load);
  }
  discardPrefetch(url, token);
  return load();
}

// Starts fetchPullInfo's plain read ahead of need (see lib/prefetchStore).
// The response also lands in the browser cache (/api/pull-info is
// HTTP-cacheable), so a second read soon after still skips GitHub.
export function prefetchPullInfo(
  pull: PullRequestRef,
  token: string | undefined,
  group?: PrefetchGroup
): Promise<PullInfo> {
  const url = `/api/pull-info?${pullParams(pull)}`;
  return prefetchOnce(
    url,
    token,
    (signal) => requestJSON(url, { headers: buildHeaders(token), signal }),
    { group, tag: pullChangeKey(pull) }
  ) as Promise<PullInfo>;
}

// `accessOnly` asks for merge capabilities and permissions alone; checks and
// reviewers come back null.
export async function fetchPullDetailsSupplement(
  pull: PullRequestRef,
  headSha: string,
  token: string | undefined,
  signal?: AbortSignal,
  { accessOnly = false }: { accessOnly?: boolean } = {}
): Promise<PullDetailsSupplement> {
  const url = pullDetailsURL(pull, headSha, accessOnly);
  const load = async () =>
    (await requestJSON(url, {
      headers: buildHeaders(token),
      signal,
    })) as PullDetailsSupplement;
  // The full read can use a prefetch (lib/prefetchStore); the access-only
  // URL never has one.
  return takeOrLoad(url, token, load);
}

// Starts fetchPullDetailsSupplement's full read for `headSha` ahead of need
// (see lib/prefetchStore).
export function prefetchPullDetailsSupplement(
  pull: PullRequestRef,
  headSha: string,
  token: string | undefined,
  group?: PrefetchGroup
): void {
  const url = pullDetailsURL(pull, headSha, false);
  void prefetchOnce(
    url,
    token,
    (signal) => requestJSON(url, { headers: buildHeaders(token), signal }),
    { group, tag: pullChangeKey(pull) }
  );
}

// The supplement's URL, shared by the read and its prefetch so their store
// keys always match.
function pullDetailsURL(
  pull: PullRequestRef,
  headSha: string,
  accessOnly: boolean
): string {
  const params = pullParams(pull);
  params.set('head', headSha);
  if (accessOnly) {
    params.set('only', 'access');
  }
  return `/api/pull-details?${params}`;
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
