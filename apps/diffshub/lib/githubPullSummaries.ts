// Normalizes GitHub pull request payloads into the row shape the /pulls
// dashboard renders. Three upstream shapes feed it: /search/issues items (the
// cross-repo "created / assigned / review requested" buckets, which carry the
// repo only as a repository_url), GraphQL search nodes (the "active" bucket,
// which also reports the viewer's involvement per pull), and
// /repos/{o}/{r}/pulls items (pinned-repo sections, where the caller already
// knows the repo).

import { asRecord } from './untypedJson';

export type PullBucket = 'created' | 'assigned' | 'review-requested' | 'active';

export const PULL_BUCKETS: readonly PullBucket[] = [
  'created',
  'assigned',
  'review-requested',
  'active',
];

// How the viewer is involved in a pull, rendered as chips on "active" rows.
// A pull can carry several (e.g. a re-requested review after an approval).
export type PullActivity =
  | 'review-requested'
  | 'team-review-requested'
  | 'approved'
  | 'changes-requested'
  | 'reviewed'
  | 'commented';

export interface PullSummary {
  number: number;
  title: string;
  owner: string;
  repo: string;
  authorLogin?: string;
  authorAvatarUrl?: string;
  state: 'open' | 'draft';
  updatedAt: string;
  viewerPath: string;
  // Only set for the "active" bucket, whose GraphQL search reports it.
  activity?: PullActivity[];
}

// Rows per bucket section, shared by the REST and GraphQL searches.
export const PULLS_PAGE_SIZE = 25;

export function isPullBucket(value: string): value is PullBucket {
  return (PULL_BUCKETS as readonly string[]).includes(value);
}

// Which review requests count as "requested from me": 'direct' is requests
// naming the viewer (user-review-requested:), 'teams' adds requests to any
// team the viewer is on (review-requested:), which on large orgs can bury
// everything else.
export type ReviewRequestScope = 'direct' | 'teams';

export function isReviewRequestScope(
  value: string
): value is ReviewRequestScope {
  return value === 'direct' || value === 'teams';
}

// Buckets whose query depends on the ReviewRequestScope toggle.
export function bucketUsesReviewRequests(bucket: PullBucket): boolean {
  return bucket === 'review-requested' || bucket === 'active';
}

function bucketQualifier(
  bucket: PullBucket,
  reviewRequests: ReviewRequestScope
): string {
  const requested =
    reviewRequests === 'teams'
      ? 'review-requested:@me'
      : 'user-review-requested:@me';
  switch (bucket) {
    case 'created':
      return 'author:@me';
    case 'assigned':
      return 'assignee:@me';
    case 'review-requested':
      return requested;
    // Pulls waiting on the viewer or that they've joined: commenter: matches
    // conversation comments and reviewed-by: covers inline-only review
    // comments. Authored pulls already live under "created". The parentheses
    // keep the OR from swallowing the repo qualifiers appended after it.
    case 'active':
      return `(${requested} OR commenter:@me OR reviewed-by:@me) -author:@me`;
  }
}

type SearchScope = {
  excludeRepos?: readonly string[];
  repo?: string;
  // Defaults to 'direct'.
  reviewRequests?: ReviewRequestScope;
};

// Optionally scoped to a single "owner/name" repository (pinned-repo cards
// following the dashboard's active bucket tab) or scoped to exclude a set of
// repositories (the main bucket list, which drops pulls already shown in the
// pinned cards above it).
export function buildBucketSearchQuery(
  bucket: PullBucket,
  scope?: SearchScope
): string {
  return buildScopedSearchQuery(
    bucketQualifier(bucket, scope?.reviewRequests ?? 'direct'),
    scope
  );
}

function buildScopedSearchQuery(qualifier: string, scope?: SearchScope) {
  let query = `is:open is:pr archived:false ${qualifier}`;
  if (scope?.repo != null) {
    query += ` repo:${scope.repo}`;
  }
  for (const repo of scope?.excludeRepos ?? []) {
    query += ` -repo:${repo}`;
  }
  return query;
}

// repository_url looks like https://api.github.com/repos/{owner}/{repo} on
// github.com and https://<host>/api/v3/repos/{owner}/{repo} on GHES; the two
// segments after "repos" identify the repository on both.
function parseRepositoryURL(
  value: unknown
): { owner: string; repo: string } | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  let segments: string[];
  try {
    segments = new URL(value).pathname.split('/').filter(Boolean);
  } catch {
    return undefined;
  }
  const reposIndex = segments.lastIndexOf('repos');
  const owner = segments[reposIndex + 1];
  const repo = segments[reposIndex + 2];
  if (reposIndex === -1 || owner == null || repo == null) {
    return undefined;
  }
  return { owner, repo };
}

function parsePullItem(
  value: unknown,
  repoRef?: { owner: string; repo: string }
): PullSummary | undefined {
  if (typeof value !== 'object' || value == null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const ref = repoRef ?? parseRepositoryURL(record.repository_url);
  if (
    ref == null ||
    typeof record.number !== 'number' ||
    typeof record.title !== 'string' ||
    typeof record.updated_at !== 'string'
  ) {
    return undefined;
  }
  const user = asRecord(record.user);
  return buildPullSummary({
    ...ref,
    number: record.number,
    title: record.title,
    isDraft: record.draft === true,
    updatedAt: record.updated_at,
    authorLogin: user?.login,
    authorAvatarUrl: user?.avatar_url,
  });
}

// Assembles the row once both payload shapes have been read into the same
// field names: derives state and viewerPath, and drops empty author fields.
function buildPullSummary(fields: {
  owner: string;
  repo: string;
  number: number;
  title: string;
  isDraft: boolean;
  updatedAt: string;
  authorLogin: unknown;
  authorAvatarUrl: unknown;
}): PullSummary {
  const { owner, repo, number, authorLogin, authorAvatarUrl } = fields;
  const summary: PullSummary = {
    number,
    title: fields.title,
    owner,
    repo,
    state: fields.isDraft ? 'draft' : 'open',
    updatedAt: fields.updatedAt,
    viewerPath: `/${owner}/${repo}/pull/${number}`,
  };
  if (typeof authorLogin === 'string' && authorLogin !== '') {
    summary.authorLogin = authorLogin;
  }
  if (typeof authorAvatarUrl === 'string' && authorAvatarUrl !== '') {
    summary.authorAvatarUrl = authorAvatarUrl;
  }
  return summary;
}

export function parseSearchIssuesPayload(payload: unknown): {
  pulls: PullSummary[];
  totalCount: number;
} {
  if (typeof payload !== 'object' || payload == null) {
    return { pulls: [], totalCount: 0 };
  }
  const record = payload as Record<string, unknown>;
  const items = Array.isArray(record.items) ? record.items : [];
  const pulls = items
    .map((item) => parsePullItem(item))
    .filter((pull): pull is PullSummary => pull != null);
  const totalCount =
    typeof record.total_count === 'number' ? record.total_count : pulls.length;
  return { pulls, totalCount };
}

export function parseRepoPullsPayload(
  owner: string,
  repo: string,
  payload: unknown
): PullSummary[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload
    .map((item) => parsePullItem(item, { owner, repo }))
    .filter((pull): pull is PullSummary => pull != null);
}

// One GraphQL request for the "active" bucket: the pull list itself plus a
// commenter:@me subset (ids only) that marks which rows the viewer commented
// on, since no per-pull viewer field reports conversation comments. Both
// searches share the scope and sort by most recently updated, so every
// commented pull in the main page also lands in the subset's page.
// ISSUE_ADVANCED opts into the search syntax that understands the OR group.
export const ACTIVE_PULLS_QUERY = `query ($query: String!, $commentedQuery: String!, $first: Int!) {
  pulls: search(query: $query, type: ISSUE_ADVANCED, first: $first) {
    issueCount
    nodes {
      ... on PullRequest {
        id
        number
        title
        isDraft
        updatedAt
        author { login avatarUrl }
        repository { name owner { login } }
        viewerLatestReview { state }
        viewerLatestReviewRequest { requestedReviewer { __typename } }
      }
    }
  }
  commented: search(query: $commentedQuery, type: ISSUE_ADVANCED, first: $first) {
    nodes { ... on PullRequest { id } }
  }
}`;

export function buildActivePullsVariables(scope: SearchScope): {
  commentedQuery: string;
  first: number;
  query: string;
} {
  const sorted = (query: string) => `${query} sort:updated-desc`;
  return {
    commentedQuery: sorted(
      buildScopedSearchQuery('commenter:@me -author:@me', scope)
    ),
    first: PULLS_PAGE_SIZE,
    query: sorted(buildBucketSearchQuery('active', scope)),
  };
}

// Chips in display order: what's waiting on the viewer first, then where
// their last review left things, then conversation comments.
function readViewerActivity(
  record: Record<string, unknown>,
  commentedIds: ReadonlySet<string>
): PullActivity[] {
  const activity: PullActivity[] = [];
  const request = asRecord(record.viewerLatestReviewRequest);
  if (request != null) {
    activity.push(
      asRecord(request.requestedReviewer)?.__typename === 'Team'
        ? 'team-review-requested'
        : 'review-requested'
    );
  }
  // PENDING is the viewer's own unsubmitted draft review; nobody else can see
  // it yet, so it doesn't count as having reviewed.
  switch (asRecord(record.viewerLatestReview)?.state) {
    case 'APPROVED':
      activity.push('approved');
      break;
    case 'CHANGES_REQUESTED':
      activity.push('changes-requested');
      break;
    case 'COMMENTED':
    case 'DISMISSED':
      activity.push('reviewed');
      break;
  }
  if (typeof record.id === 'string' && commentedIds.has(record.id)) {
    activity.push('commented');
  }
  return activity;
}

function parseGraphQLPullNode(
  value: unknown,
  commentedIds: ReadonlySet<string>
): PullSummary | undefined {
  const record = asRecord(value);
  const repository = asRecord(record?.repository);
  const owner = asRecord(repository?.owner)?.login;
  const repo = repository?.name;
  if (
    record == null ||
    typeof owner !== 'string' ||
    typeof repo !== 'string' ||
    typeof record.number !== 'number' ||
    typeof record.title !== 'string' ||
    typeof record.updatedAt !== 'string'
  ) {
    return undefined;
  }
  const author = asRecord(record.author);
  return {
    ...buildPullSummary({
      owner,
      repo,
      number: record.number,
      title: record.title,
      isDraft: record.isDraft === true,
      updatedAt: record.updatedAt,
      authorLogin: author?.login,
      authorAvatarUrl: author?.avatarUrl,
    }),
    activity: readViewerActivity(record, commentedIds),
  };
}

// Reads ACTIVE_PULLS_QUERY's `data` into the same { pulls, totalCount } shape
// the REST search buckets return.
export function parseActivePullsPayload(data: unknown): {
  pulls: PullSummary[];
  totalCount: number;
} {
  const pullsSearch = asRecord(asRecord(data)?.pulls);
  const commentedNodes = asRecord(asRecord(data)?.commented)?.nodes;
  const commentedIds = new Set<string>();
  for (const node of Array.isArray(commentedNodes) ? commentedNodes : []) {
    const id = asRecord(node)?.id;
    if (typeof id === 'string') {
      commentedIds.add(id);
    }
  }
  const nodes = Array.isArray(pullsSearch?.nodes) ? pullsSearch.nodes : [];
  const pulls = nodes
    .map((node) => parseGraphQLPullNode(node, commentedIds))
    .filter((pull): pull is PullSummary => pull != null);
  const totalCount =
    typeof pullsSearch?.issueCount === 'number'
      ? pullsSearch.issueCount
      : pulls.length;
  return { pulls, totalCount };
}
