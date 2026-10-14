// Normalizes GitHub pull request payloads into the row shape the /pulls
// dashboard renders. Two upstream shapes feed it: GraphQL search nodes (the
// "active" list, which also reports the viewer's involvement per pull) and
// /repos/{o}/{r}/pulls items (repo cards, where the caller already knows the
// repo).

import { asRecord } from './untypedJson';

// The ways a viewer can be involved in a pull. The /pulls "active" list is
// the OR of all of them; each doubles as a filter chip that narrows the
// search to the selected terms.
export type PullInvolvement =
  | 'review-requested'
  | 'authored'
  | 'reviewed'
  | 'commented'
  | 'assigned';

// Filter chip order on the dashboard, and the canonical order for
// serializing a selection: what's waiting on the viewer first, assigned last
// since few teams set assignees on pulls.
export const PULL_INVOLVEMENTS: readonly PullInvolvement[] = [
  'review-requested',
  'authored',
  'reviewed',
  'commented',
  'assigned',
];

// How the viewer is involved in a pull, rendered as chips on each row: the
// filterable involvements plus finer review detail. A pull can carry several
// (e.g. a re-requested review after an approval). As a row chip, "reviewed"
// means a review that neither approved nor requested changes.
export type PullActivity =
  | PullInvolvement
  | 'team-review-requested'
  | 'approved'
  | 'changes-requested';

// Shared by the row chips and the dashboard's filter chips.
export const PULL_ACTIVITY_LABELS: Record<PullActivity, string> = {
  'review-requested': 'Review requested',
  'team-review-requested': 'Team review requested',
  authored: 'Authored',
  assigned: 'Assigned',
  approved: 'Approved',
  'changes-requested': 'Changes requested',
  reviewed: 'Reviewed',
  commented: 'Commented',
};

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
  // Only set on "active" rows, whose GraphQL search reports it.
  activity?: PullActivity[];
}

// Rows per active-list section.
const PULLS_PAGE_SIZE = 25;

// Canonical form of a selection: chip order, no duplicates, and the empty
// list for "all" — including when every chip is selected, so that selection
// shares the All chip's URL, cache entry, and copy.
export function normalizePullInvolvements(
  entries: readonly string[]
): PullInvolvement[] {
  const selected = PULL_INVOLVEMENTS.filter((involvement) =>
    entries.includes(involvement)
  );
  return selected.length === PULL_INVOLVEMENTS.length ? [] : selected;
}

// Parses a comma-separated involvement list (the ?involves= param). Empty or
// missing means "all"; returns undefined when any entry is unknown.
export function parsePullInvolvements(
  value: string | null
): PullInvolvement[] | undefined {
  const entries = value == null || value === '' ? [] : value.split(',');
  return entries.every((entry) =>
    (PULL_INVOLVEMENTS as readonly string[]).includes(entry)
  )
    ? normalizePullInvolvements(entries)
    : undefined;
}

// The involvements a normalized selection searches for.
function effectivePullInvolvements(
  involves: readonly PullInvolvement[]
): readonly PullInvolvement[] {
  return involves.length === 0 ? PULL_INVOLVEMENTS : involves;
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

// Whether the ReviewRequestScope toggle changes the search for this
// selection.
export function involvementsUseReviewRequests(
  involves: readonly PullInvolvement[]
): boolean {
  return effectivePullInvolvements(involves).includes('review-requested');
}

// Replying on your own pull leaves conversation comments and COMMENTED
// reviews, which isn't reviewing or commenting in the sense these chips mean,
// so those terms skip the viewer's own pulls.
const NOT_OWN = '-author:@me';
const SKIPS_OWN_PULLS: ReadonlySet<PullInvolvement> = new Set([
  'reviewed',
  'commented',
]);

function involvementQualifier(
  involvement: PullInvolvement,
  reviewRequests: ReviewRequestScope
): string {
  switch (involvement) {
    case 'review-requested':
      return reviewRequests === 'teams'
        ? 'review-requested:@me'
        : 'user-review-requested:@me';
    case 'authored':
      return 'author:@me';
    // reviewed-by: also covers inline-only review comments, which commenter:
    // (conversation comments) misses.
    case 'reviewed':
      return 'reviewed-by:@me';
    case 'commented':
      return 'commenter:@me';
    case 'assigned':
      return 'assignee:@me';
  }
}

// The search term for one involvement, with NOT_OWN appended for the terms
// that skip the viewer's own pulls.
function involvementTerm(
  involvement: PullInvolvement,
  reviewRequests: ReviewRequestScope
): string {
  const qualifier = involvementQualifier(involvement, reviewRequests);
  return SKIPS_OWN_PULLS.has(involvement)
    ? `${qualifier} ${NOT_OWN}`
    : qualifier;
}

type SearchScope = {
  excludeRepos?: readonly string[];
  // Normalized; empty means every involvement.
  involves: readonly PullInvolvement[];
  repo?: string;
  // Defaults to 'direct'.
  reviewRequests?: ReviewRequestScope;
};

// The selected involvements as one search qualifier: a single term as-is,
// several as a parenthesized OR group (terms that skip own pulls grouped
// with NOT_OWN too), so the group can't swallow the qualifiers appended
// after it.
function activeQualifier(scope: SearchScope): string {
  const involves = effectivePullInvolvements(scope.involves);
  const reviewRequests = scope.reviewRequests ?? 'direct';
  const [only] = involves;
  if (involves.length === 1 && only != null) {
    return involvementTerm(only, reviewRequests);
  }
  const terms = involves.map((involvement) => {
    const term = involvementTerm(involvement, reviewRequests);
    return SKIPS_OWN_PULLS.has(involvement) ? `(${term})` : term;
  });
  return `(${terms.join(' OR ')})`;
}

// The active-list search: open pulls matching any selected involvement,
// optionally scoped to one "owner/name" repository (pinned-repo cards) or
// excluding a set of them (the main list, which drops pulls already shown in
// the pinned cards above it). `extra` narrows the involvement match further.
export function buildActiveSearchQuery(
  scope: SearchScope,
  extra?: string
): string {
  let query = `is:open is:pr archived:false ${activeQualifier(scope)}`;
  if (extra != null) {
    query += ` ${extra}`;
  }
  if (scope.repo != null) {
    query += ` repo:${scope.repo}`;
  }
  for (const repo of scope.excludeRepos ?? []) {
    query += ` -repo:${repo}`;
  }
  return query;
}

function parsePullItem(
  value: unknown,
  repoRef: { owner: string; repo: string }
): PullSummary | undefined {
  if (typeof value !== 'object' || value == null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.number !== 'number' ||
    typeof record.title !== 'string' ||
    typeof record.updated_at !== 'string'
  ) {
    return undefined;
  }
  const user = asRecord(record.user);
  return buildPullSummary({
    ...repoRef,
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

// One GraphQL request for an active-list section: the pull list itself plus a
// commenter:@me subset (ids only) that marks which rows the viewer commented
// on, since no per-pull viewer field reports conversation comments. The
// subset is the main search narrowed by the "commented" term, sorted the same
// way, so every commented pull in the main page also lands in the subset's
// page.
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
        viewerDidAuthor
        viewerLatestReview { state }
        viewerLatestReviewRequest { requestedReviewer { __typename } }
        assignees(first: 10) { nodes { isViewer } }
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
      buildActiveSearchQuery(
        scope,
        involvementTerm('commented', scope.reviewRequests ?? 'direct')
      )
    ),
    first: PULLS_PAGE_SIZE,
    query: sorted(buildActiveSearchQuery(scope)),
  };
}

// Chips in display order: authorship, what's waiting on the viewer, then
// where their last review left things, then conversation comments. Own pulls
// skip the review and comment chips for the same reason the search terms
// skip own pulls (NOT_OWN).
function readViewerActivity(
  record: Record<string, unknown>,
  commentedIds: ReadonlySet<string>
): PullActivity[] {
  const own = record.viewerDidAuthor === true;
  const activity: PullActivity[] = own ? ['authored'] : [];
  const request = asRecord(record.viewerLatestReviewRequest);
  if (request != null) {
    activity.push(
      asRecord(request.requestedReviewer)?.__typename === 'Team'
        ? 'team-review-requested'
        : 'review-requested'
    );
  }
  const assignees = asRecord(record.assignees)?.nodes;
  if (
    Array.isArray(assignees) &&
    assignees.some((node) => asRecord(node)?.isViewer === true)
  ) {
    activity.push('assigned');
  }
  if (own) {
    return activity;
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

// Reads ACTIVE_PULLS_QUERY's `data` into the { pulls, totalCount } shape the
// dashboard sections render.
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
