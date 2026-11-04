// Builds the /pulls dashboard's GitHub search and normalizes its GraphQL
// results into the row shape the dashboard renders. One search shape covers
// every view: the viewer's involvement terms (or none, for "anyone"), an
// optional set of repositories, and the GitHub search text typed in the
// page's query bar.

import type { PullLabel } from './pullInfoClient';
import {
  DEFAULT_PULL_SORT,
  hasOrOperator,
  hasQualifier,
  splitPullSort,
} from './pullSearchQuery';
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
  state: 'open' | 'draft' | 'closed' | 'merged';
  updatedAt: string;
  viewerPath: string;
  labels?: PullLabel[];
  // How the viewer is involved, as reported by the GraphQL search.
  activity?: PullActivity[];
}

// "anyone" drops the involvement terms entirely: every pull matching the rest
// of the search, which is what a repository's own pull request list shows.
export type PullAudience = readonly PullInvolvement[] | 'anyone';

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

interface PullSearchScope {
  // Normalized involvements (empty means every involvement), or "anyone".
  involves: PullAudience;
  // Restricts the search to these "owner/name" repositories (OR'd).
  repos?: readonly string[];
  // Defaults to 'direct'.
  reviewRequests?: ReviewRequestScope;
  // The query bar's GitHub search text, e.g. "is:open label:bug". Its last
  // sort: qualifier (if any) replaces the default recently-updated order.
  text?: string;
}

// The selected involvements as one search qualifier: a single term as-is,
// several as a parenthesized OR group (terms that skip own pulls grouped
// with NOT_OWN too), so the group can't swallow the qualifiers appended
// after it. Undefined for "anyone".
function audienceQualifier(scope: PullSearchScope): string | undefined {
  if (scope.involves === 'anyone') {
    return undefined;
  }
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

function reposQualifier(repos: readonly string[]): string | undefined {
  if (repos.length === 0) {
    return undefined;
  }
  const terms = repos.map((repo) => `repo:${repo}`);
  return terms.length === 1 ? terms[0] : `(${terms.join(' OR ')})`;
}

// The dashboard search, minus its sort: the typed text first (grouped when it
// has its own OR, so the AND-ed scope terms after it apply to every branch),
// then is:pr, the audience, `extra` (which narrows the audience further), and
// the repository scope. Archived repos are skipped unless the text says
// otherwise.
export function buildActiveSearchQuery(
  scope: PullSearchScope,
  extra?: string
): string {
  const { rest } = splitPullSort(scope.text ?? '');
  const parts: string[] = [];
  if (rest !== '') {
    parts.push(hasOrOperator(rest) ? `(${rest})` : rest);
  }
  parts.push('is:pr');
  if (!hasQualifier(rest, 'archived')) {
    parts.push('archived:false');
  }
  const audience = audienceQualifier(scope);
  if (audience != null) {
    parts.push(audience);
  }
  if (extra != null) {
    parts.push(extra);
  }
  const repos = reposQualifier(scope.repos ?? []);
  if (repos != null) {
    parts.push(repos);
  }
  return parts.join(' ');
}

// The sort the search runs with: the typed one, or recently updated first.
function readSearchSort(scope: PullSearchScope): string {
  return splitPullSort(scope.text ?? '').sort ?? DEFAULT_PULL_SORT;
}

// Assembles the row from a search node's fields: derives viewerPath and
// drops empty author fields.
function buildPullSummary(fields: {
  owner: string;
  repo: string;
  number: number;
  title: string;
  state: PullSummary['state'];
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
    state: fields.state,
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

// One GraphQL request for a page of the dashboard list: the pull page itself
// plus a commenter:@me subset (ids only) that marks which rows the viewer
// commented on, since no per-pull viewer field reports conversation comments.
// The subset is the main search narrowed by the "commented" term, sorted the
// same way, so every commented pull in the main page also lands in the
// subset's page (see buildActivePullsVariables for later pages).
// $withCommented skips the subset when it can't match anything.
// ISSUE_ADVANCED opts into the search syntax that understands OR groups.
export const ACTIVE_PULLS_QUERY = `query ($query: String!, $commentedQuery: String!, $withCommented: Boolean!, $first: Int!, $commentedFirst: Int!, $after: String) {
  pulls: search(query: $query, type: ISSUE_ADVANCED, first: $first, after: $after) {
    issueCount
    pageInfo { endCursor hasNextPage }
    nodes {
      ... on PullRequest {
        id
        number
        title
        isDraft
        state
        updatedAt
        labels(first: 6) { nodes { name color } }
        author { login avatarUrl }
        repository { name owner { login } }
        viewerDidAuthor
        viewerLatestReview { state }
        viewerLatestReviewRequest { requestedReviewer { __typename } }
        assignees(first: 10) { nodes { isViewer } }
      }
    }
  }
  commented: search(query: $commentedQuery, type: ISSUE_ADVANCED, first: $commentedFirst) @include(if: $withCommented) {
    nodes { ... on PullRequest { id } }
  }
}`;

// Where the next page starts: GitHub's search cursor, the updatedAt of the
// last row already shown (which bounds the commented subset on that page),
// and how many shown rows share that timestamp (the subset's overlap with
// what's already on screen). Serialized opaquely so the client just echoes
// it back.
interface PullsPageCursor {
  after: string;
  lastUpdatedAt: string;
  boundaryRows: number;
}

export function encodePullsCursor(cursor: PullsPageCursor): string {
  return btoa(
    JSON.stringify([cursor.after, cursor.lastUpdatedAt, cursor.boundaryRows])
  );
}

export function decodePullsCursor(value: string): PullsPageCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(atob(value));
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(parsed[1]) &&
      Number.isInteger(parsed[2]) &&
      parsed[2] >= 1 &&
      parsed[2] <= PULLS_PAGE_SIZE
    ) {
      return {
        after: parsed[0],
        lastUpdatedAt: parsed[1],
        boundaryRows: parsed[2] as number,
      };
    }
  } catch {
    // Fall through: a malformed cursor reads as no cursor.
  }
  return undefined;
}

// The commented subset on a later page. The subset can't share the main
// search's cursor, so it restarts from the previous page's last updatedAt
// instead. The bound is inclusive (rows on this page can share that
// timestamp), so the subset can also return already-shown rows at the
// boundary; buildActivePullsVariables widens it by that many so they can't
// crowd out this page's last rows. Only the updated sorts have such a bound;
// other sorts skip the chips' commented detail past page one.
function laterPageCommentedBound(
  sort: string,
  cursor: PullsPageCursor
): string | undefined {
  if (sort === 'updated' || sort === DEFAULT_PULL_SORT) {
    return `updated:<=${cursor.lastUpdatedAt}`;
  }
  if (sort === 'updated-asc') {
    return `updated:>=${cursor.lastUpdatedAt}`;
  }
  return undefined;
}

export function buildActivePullsVariables(
  scope: PullSearchScope,
  cursor?: PullsPageCursor
): {
  after?: string;
  commentedFirst: number;
  commentedQuery: string;
  first: number;
  query: string;
  withCommented: boolean;
} {
  const sort = readSearchSort(scope);
  const sorted = (query: string) => `${query} sort:${sort}`;
  const commentedTerm = involvementTerm(
    'commented',
    scope.reviewRequests ?? 'direct'
  );
  const bound =
    cursor == null ? undefined : laterPageCommentedBound(sort, cursor);
  const commentedExtra =
    bound == null ? commentedTerm : `${commentedTerm} ${bound}`;
  // The commented term skips own pulls, so an Authored-only selection can
  // never overlap it.
  const audienceCanComment =
    scope.involves === 'anyone' ||
    !effectivePullInvolvements(scope.involves).every(
      (involvement) => involvement === 'authored'
    );
  // An undefined `after` drops out of the serialized variables.
  return {
    after: cursor?.after,
    commentedFirst:
      PULLS_PAGE_SIZE + (bound == null ? 0 : (cursor?.boundaryRows ?? 0)),
    commentedQuery: sorted(buildActiveSearchQuery(scope, commentedExtra)),
    first: PULLS_PAGE_SIZE,
    query: sorted(buildActiveSearchQuery(scope)),
    withCommented: audienceCanComment && (cursor == null || bound != null),
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
  const summary: PullSummary = {
    ...buildPullSummary({
      owner,
      repo,
      number: record.number,
      title: record.title,
      state: readPullState(record),
      updatedAt: record.updatedAt,
      authorLogin: author?.login,
      authorAvatarUrl: author?.avatarUrl,
    }),
    activity: readViewerActivity(record, commentedIds),
  };
  const labels = readLabels(record);
  if (labels.length > 0) {
    summary.labels = labels;
  }
  return summary;
}

// Merged and closed win over draft: a closed draft reads as closed on GitHub.
function readPullState(record: Record<string, unknown>): PullSummary['state'] {
  if (record.state === 'MERGED') {
    return 'merged';
  }
  if (record.state === 'CLOSED') {
    return 'closed';
  }
  return record.isDraft === true ? 'draft' : 'open';
}

function readLabels(record: Record<string, unknown>): PullLabel[] {
  const nodes = asRecord(record.labels)?.nodes;
  const labels: PullLabel[] = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const label = asRecord(node);
    if (
      typeof label?.name === 'string' &&
      typeof label.color === 'string' &&
      /^[0-9a-f]{6}$/i.test(label.color)
    ) {
      labels.push({ name: label.name, color: label.color });
    }
  }
  return labels;
}

export interface PullsPage {
  pulls: PullSummary[];
  totalCount: number;
  // Present while GitHub reports another page.
  nextCursor?: string;
}

// Reads ACTIVE_PULLS_QUERY's `data` into the page shape the dashboard
// renders.
export function parseActivePullsPayload(data: unknown): PullsPage {
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
  const pageInfo = asRecord(pullsSearch?.pageInfo);
  const last = pulls.at(-1);
  if (
    pageInfo?.hasNextPage === true &&
    typeof pageInfo.endCursor === 'string' &&
    last != null
  ) {
    return {
      pulls,
      totalCount,
      nextCursor: encodePullsCursor({
        after: pageInfo.endCursor,
        lastUpdatedAt: last.updatedAt,
        boundaryRows: pulls.filter((pull) => pull.updatedAt === last.updatedAt)
          .length,
      }),
    };
  }
  return { pulls, totalCount };
}
