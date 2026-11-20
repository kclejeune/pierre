// Builds the /pulls dashboard's GitHub search and normalizes its GraphQL
// results into the row shape the dashboard renders. One search shape covers
// every view: the viewer's involvement terms (or none, for "anyone"), an
// optional set of repositories, and the GitHub search text typed in the
// page's query bar.

import { matchesMutedBranch } from './muteRules';
import { includesName } from './nameList';
import type { PullRequestRef } from './pullCommentsClient';
import type { PullDetails, PullLabel } from './pullInfoClient';
import { parseLabels } from './pullLabels';
import {
  DEFAULT_PULL_SORT,
  hasOrOperator,
  hasQualifier,
  listsOnlyOpenPulls,
  normalizeQualifierNegation,
  readPositiveQualifierValues,
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
  // The author is a GitHub App bot (renovate, dependabot, ...), which
  // searches as author:app/<login>.
  authorIsBot?: boolean;
  state: 'open' | 'draft' | 'closed' | 'merged';
  updatedAt: string;
  viewerPath: string;
  labels?: PullLabel[];
  // How the viewer is involved, as reported by the GraphQL search.
  activity?: PullActivity[];
  // The head commit's combined CI result. Absent when the commit has no
  // checks or the token can't read them.
  checks?: PullChecksSummary;
  // The pull's overall review state under branch protection. Absent when
  // the base branch doesn't require reviews.
  reviewDecision?: PullReviewDecision;
  // The head commit when the list loaded, so the preview's details
  // supplement (keyed by head) can be prefetched alongside its pull info.
  headSha?: string;
  // The branch the pull comes from, which branch mutes (lib/muteRules)
  // match by prefix.
  headRefName?: string;
  // GitHub's GraphQL node id, which the dashboard's follow-up status read
  // (PULL_STATUSES_QUERY) addresses the pull by.
  nodeId?: string;
}

export type PullChecksSummary = 'failure' | 'pending' | 'success';

export type PullReviewDecision =
  | 'approved'
  | 'changes-requested'
  | 'review-required';

export const PULL_REVIEW_DECISION_LABELS: Record<PullReviewDecision, string> = {
  approved: 'Approved',
  'changes-requested': 'Changes requested',
  'review-required': 'Review required',
};

// A pull's identity across lists, caches, and selections: "owner/repo#12".
// Takes a list row or a route's PullRequestRef (whose number is a string).
export function pullKey(pull: {
  number: number | string;
  owner: string;
  repo: string;
}): string {
  return `${pull.owner}/${pull.repo}#${pull.number}`;
}

// The app's diff path for a pull, e.g. /acme/widgets/pull/12.
export function pullViewerPath(
  owner: string,
  repo: string,
  number: number | string
): string {
  return `/${owner}/${repo}/pull/${number}`;
}

// The pull's page on the GitHub instance at `webURL`.
export function githubPullURL(
  webURL: string,
  pull: Pick<PullSummary, 'number' | 'owner' | 'repo'>
): string {
  return `${webURL.replace(/\/$/, '')}${pullViewerPath(pull.owner, pull.repo, pull.number)}`;
}

// The pull as the pull-request API clients address it.
export function pullRequestRef(
  pull: Pick<PullSummary, 'number' | 'owner' | 'repo'>
): PullRequestRef {
  return { number: String(pull.number), owner: pull.owner, repo: pull.repo };
}

// The summary the /pulls rows carry, for a pull known only by its ref and
// details (the review page), so the shared pull actions menu
// (components/PullRowActions) works there too. Fields the details don't
// carry (checks, labels, activity) stay absent, which the menu doesn't read.
export function pullSummaryFromDetails(
  ref: PullRequestRef,
  details: PullDetails
): PullSummary {
  const number = Number(ref.number);
  return {
    authorAvatarUrl: details.authorAvatarUrl,
    // The REST details name apps by their "[bot]" login (dependabot[bot]),
    // a suffix no user login can carry; muting needs the app/ form.
    authorIsBot: /\[bot\]$/i.test(details.authorLogin ?? '') || undefined,
    authorLogin: details.authorLogin,
    number,
    owner: ref.owner,
    repo: ref.repo,
    state: displayPullState(details.state, details.draft),
    title: details.title,
    updatedAt: details.createdAt ?? '',
    viewerPath: pullViewerPath(ref.owner, ref.repo, number),
  };
}

// "anyone" drops the involvement terms entirely: every pull matching the rest
// of the search, which is what a repository's own pull request list shows.
export type PullAudience = readonly PullInvolvement[] | 'anyone';

// Rows per active-list section.
const PULLS_PAGE_SIZE = 25;
// GitHub search returns at most this many results in total, which bounds how
// many shown rows can share a boundary timestamp.
const MAX_SEARCH_RESULTS = 1000;
// GraphQL connections return at most this many nodes per request.
const MAX_CONNECTION_PAGE = 100;

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
export function effectivePullInvolvements(
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
  // Author search names (lib/mutedAuthors) whose pulls are left out, except
  // any the text asks for with an author: term.
  mutedAuthors?: readonly string[];
  // Head-branch prefixes (lib/muteRules) whose pulls are left out, except
  // any the text asks for with a head: term.
  mutedBranches?: readonly string[];
  // The `updated:>=` value (lib/muteRules staleCutoff) open pulls must meet,
  // when staleness muting is on and the search allows it (see
  // staleMutingApplies).
  staleCutoff?: string;
  // Lists only the pulls muting would leave out (any muted author or
  // branch, or stale) instead of leaving them out. With nothing muted that
  // is nothing, so buildActivePullsRequests sends no search.
  mutedOnly?: boolean;
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

// The muted names a search actually excludes: all but those the search text
// asks for with a positive `qualifier` term, since excluding one the viewer
// typed in would empty the list. `isNamed` matches a muted name against the
// typed values the same way the mute itself matches pulls. The server builds
// its exclusions from this and the dashboard dims the same rows, so the two
// agree.
function effectiveMutedNames(
  muted: readonly string[],
  text: string,
  qualifier: 'author' | 'head',
  isNamed: (typed: readonly string[], name: string) => boolean
): readonly string[] {
  if (muted.length === 0) {
    return muted;
  }
  const typed = readPositiveQualifierValues(text, qualifier);
  return muted.filter((name) => !isNamed(typed, name));
}

export function effectiveMutedAuthors(
  muted: readonly string[],
  text: string
): readonly string[] {
  return effectiveMutedNames(muted, text, 'author', includesName);
}

// Muted branches are prefixes, so a typed head: under one (head:renovate/x
// with renovate muted) lifts it.
export function effectiveMutedBranches(
  muted: readonly string[],
  text: string
): readonly string[] {
  return effectiveMutedNames(muted, text, 'head', (typed, prefix) =>
    typed.some((head) => matchesMutedBranch([prefix], head))
  );
}

// Whether a search hides stale pulls: only one listing open pulls (age is
// what makes an open pull noise; a merged or closed one is history), and not
// when the text already filters or sorts by update time, which says the
// viewer is looking at age on purpose.
export function staleMutingApplies(text: string): boolean {
  return (
    listsOnlyOpenPulls(text) &&
    !hasQualifier(text, 'updated') &&
    splitPullSort(text).sort !== 'updated-asc'
  );
}

// What makes a pull muted for this search, one rule per muted author, muted
// branch prefix, and the staleness cutoff: the term that matches the pulls
// it mutes, and the term that leaves them out.
function mutedPullRules(
  scope: PullSearchScope
): { exclude: string; match: string }[] {
  const text = scope.text ?? '';
  const rules = [
    ...effectiveMutedAuthors(scope.mutedAuthors ?? [], text).map((author) => ({
      exclude: `-author:${author}`,
      match: `author:${author}`,
    })),
    ...effectiveMutedBranches(scope.mutedBranches ?? [], text).map(
      (prefix) => ({ exclude: `-head:${prefix}`, match: `head:${prefix}` })
    ),
  ];
  if (scope.staleCutoff != null && staleMutingApplies(text)) {
    rules.push({
      exclude: `updated:>=${scope.staleCutoff}`,
      match: `updated:<${scope.staleCutoff}`,
    });
  }
  return rules;
}

// The terms muting adds to a search: normally every rule's exclusion, AND-ed;
// for mutedOnly, the rules' matches as one OR group, which ISSUE_ADVANCED
// search reads across qualifier types.
function scopeMuteTerms(scope: PullSearchScope): string[] {
  const rules = mutedPullRules(scope);
  if (scope.mutedOnly !== true) {
    return rules.map((rule) => rule.exclude);
  }
  const matches = rules.map((rule) => rule.match);
  return matches.length <= 1 ? matches : [`(${matches.join(' OR ')})`];
}

// The dashboard search, minus its sort: the typed text first (grouped when it
// has its own OR, so the AND-ed scope terms after it apply to every branch),
// then is:pr, the audience, `extra` (which narrows the audience further), the
// repository scope, and the muting terms (scopeMuteTerms). Archived repos are
// skipped unless the text says otherwise.
export function buildActiveSearchQuery(
  scope: PullSearchScope,
  extra?: string
): string {
  return [buildUnmutedSearchQuery(scope, extra), ...scopeMuteTerms(scope)].join(
    ' '
  );
}

// The dashboard's search for typed `text` within `repos` (every repository
// when empty), without its audience or muting terms: the command palette's
// pull request search, so it matches what the list would for that text.
export function buildPullTextSearch(
  text: string,
  repos: readonly string[]
): string {
  return buildUnmutedSearchQuery({ involves: 'anyone', repos, text });
}

// buildActiveSearchQuery without the muting terms, whose hit count tells how
// many pulls muting hides.
function buildUnmutedSearchQuery(
  scope: PullSearchScope,
  extra?: string
): string {
  // GitHub reads NOT before a qualifier as a match-nothing keyword search.
  const rest = normalizeQualifierNegation(splitPullSort(scope.text ?? '').rest);
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
  authorType: unknown;
}): PullSummary {
  const { owner, repo, number, authorLogin, authorAvatarUrl } = fields;
  const summary: PullSummary = {
    number,
    title: fields.title,
    owner,
    repo,
    state: fields.state,
    updatedAt: fields.updatedAt,
    viewerPath: pullViewerPath(owner, repo, number),
  };
  if (typeof authorLogin === 'string' && authorLogin !== '') {
    summary.authorLogin = authorLogin;
  }
  if (typeof authorAvatarUrl === 'string' && authorAvatarUrl !== '') {
    summary.authorAvatarUrl = authorAvatarUrl;
  }
  if (fields.authorType === 'Bot') {
    summary.authorIsBot = true;
  }
  return summary;
}

// A page of the dashboard list takes up to three GraphQL searches, sent as
// concurrent requests (buildActivePullsRequests) rather than aliases of one
// query, since GitHub resolves a query's aliases one after another:
//
// - ACTIVE_PULLS_QUERY, the pull page itself.
// - COMMENTED_PULLS_QUERY, a commenter:@me subset (ids only) that marks which
//   rows the viewer commented on, since no per-pull viewer field reports
//   conversation comments. The subset is the main search narrowed by the
//   "commented" term, sorted the same way, so every commented pull in the
//   main page also lands in the subset's page (see buildActivePullsVariables
//   for later pages). Skipped when it can't match anything.
// - UNMUTED_COUNT_QUERY, on the first page of a muted search: the same
//   search without the muting terms, counted, so the list can say how many
//   pulls muting hid.
//
// Each response's data sits under its own alias (pulls, commented,
// unmuted), so merging the three objects gives parseActivePullsPayload the
// shape one combined query would have returned. CI and review state are not
// part of the page: they cost more than the search itself, so the dashboard
// reads them afterwards (PULL_STATUSES_QUERY). ISSUE_ADVANCED opts into the
// search syntax that understands OR groups.
export const ACTIVE_PULLS_QUERY = `query ($query: String!, $first: Int!, $after: String) {
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
        headRefOid
        headRefName
        labels(first: 6) { nodes { name color } }
        author { __typename login avatarUrl }
        repository { name owner { login } }
        viewerDidAuthor
        viewerLatestReview { state }
        viewerLatestReviewRequest { requestedReviewer { __typename } }
        assignees(first: 10) { nodes { isViewer } }
      }
    }
  }
}`;

export const COMMENTED_PULLS_QUERY = `query ($commentedQuery: String!, $commentedFirst: Int!) {
  commented: search(query: $commentedQuery, type: ISSUE_ADVANCED, first: $commentedFirst) {
    nodes { ... on PullRequest { id } }
  }
}`;

export const UNMUTED_COUNT_QUERY = `query ($unmutedQuery: String!) {
  unmuted: search(query: $unmutedQuery, type: ISSUE_ADVANCED, first: 1) {
    issueCount
  }
}`;

// One of a page's searches: the alias its data comes back under (which is
// also where its tolerated null nodes sit), its query, and its variables.
export interface ActivePullsRequest {
  alias: 'commented' | 'pulls' | 'unmuted';
  query: string;
  variables: Record<string, unknown>;
}

// The searches one page of the list sends (see ACTIVE_PULLS_QUERY), each
// with only the variables its query declares. The commented and unmuted
// searches are left out when buildActivePullsVariables switches them off.
export function buildActivePullsRequests(
  scope: PullSearchScope,
  cursor?: PullsPageCursor
): ActivePullsRequest[] {
  // Only muted pulls, but nothing is muted: no search can express "match
  // nothing", so none goes out and the page parses as empty.
  if (scope.mutedOnly === true && mutedPullRules(scope).length === 0) {
    return [];
  }
  const variables = buildActivePullsVariables(scope, cursor);
  const requests: ActivePullsRequest[] = [
    {
      alias: 'pulls',
      query: ACTIVE_PULLS_QUERY,
      variables: {
        after: variables.after,
        first: variables.first,
        query: variables.query,
      },
    },
  ];
  if (variables.withCommented) {
    requests.push({
      alias: 'commented',
      query: COMMENTED_PULLS_QUERY,
      variables: {
        commentedFirst: variables.commentedFirst,
        commentedQuery: variables.commentedQuery,
      },
    });
  }
  if (variables.withUnmuted) {
    requests.push({
      alias: 'unmuted',
      query: UNMUTED_COUNT_QUERY,
      variables: { unmutedQuery: variables.unmutedQuery },
    });
  }
  return requests;
}

// Joins the responses of a page's searches into one payload for
// parseActivePullsPayload, taking from each response only its own alias.
export function mergeActivePullsResponses(
  responses: readonly { alias: ActivePullsRequest['alias']; data: unknown }[]
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const { alias, data } of responses) {
    const value = asRecord(data)?.[alias];
    if (value !== undefined) {
      merged[alias] = value;
    }
  }
  return merged;
}

// Where the next page starts: GitHub's search cursor, the updatedAt of the
// last readable row so far (which bounds the commented subset on the next
// page; absent until a readable row appears), and how many search hits
// already paged past can still fall inside that bound (the subset's overlap
// with what's already been shown). Hits the viewer's GitHub App can't read
// count toward the overlap too: they still take slots in the subset's
// results. Serialized opaquely so the client just echoes it back.
interface PullsPageCursor {
  after: string;
  lastUpdatedAt?: string;
  boundaryRows: number;
}

export function encodePullsCursor(cursor: PullsPageCursor): string {
  return btoa(
    JSON.stringify([
      cursor.after,
      cursor.lastUpdatedAt ?? null,
      cursor.boundaryRows,
    ])
  );
}

export function decodePullsCursor(value: string): PullsPageCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(atob(value));
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      typeof parsed[0] === 'string' &&
      (parsed[1] === null ||
        (typeof parsed[1] === 'string' && isGitHubTimestamp(parsed[1]))) &&
      Number.isInteger(parsed[2]) &&
      parsed[2] >= 0 &&
      parsed[2] <= MAX_SEARCH_RESULTS
    ) {
      return {
        after: parsed[0],
        lastUpdatedAt: parsed[1] ?? undefined,
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
// crowd out this page's last rows. Before any readable row there is no
// bound yet, so the subset starts from the top and every hit paged past is
// overlap. Only the updated sorts can be bounded; other sorts return
// undefined and skip the chips' commented detail past page one.
function laterPageCommentedBound(
  sort: string,
  cursor: PullsPageCursor
): { bound?: string } | undefined {
  const at = cursor.lastUpdatedAt;
  if (sort === 'updated' || sort === DEFAULT_PULL_SORT) {
    return { bound: at == null ? undefined : `updated:<=${at}` };
  }
  if (sort === 'updated-asc') {
    return { bound: at == null ? undefined : `updated:>=${at}` };
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
  unmutedQuery: string;
  withCommented: boolean;
  withUnmuted: boolean;
} {
  const sort = readSearchSort(scope);
  const sorted = (query: string) => `${query} sort:${sort}`;
  const commentedTerm = involvementTerm(
    'commented',
    scope.reviewRequests ?? 'direct'
  );
  const window =
    cursor == null ? undefined : laterPageCommentedBound(sort, cursor);
  const commentedExtra =
    window?.bound == null ? commentedTerm : `${commentedTerm} ${window.bound}`;
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
    // Past GraphQL's page limit (more than 75 shown rows sharing one
    // timestamp), the overlap can crowd out some of this page's commented
    // rows; they show without the Commented chip.
    commentedFirst: Math.min(
      MAX_CONNECTION_PAGE,
      PULLS_PAGE_SIZE + (window == null ? 0 : (cursor?.boundaryRows ?? 0))
    ),
    commentedQuery: sorted(buildActiveSearchQuery(scope, commentedExtra)),
    first: PULLS_PAGE_SIZE,
    query: sorted(buildActiveSearchQuery(scope)),
    // Sort doesn't change a count, so the unmuted search runs unsorted.
    unmutedQuery: buildUnmutedSearchQuery(scope),
    withCommented: audienceCanComment && (cursor == null || window != null),
    // Listing only muted pulls hides nothing, so there's no count to take.
    withUnmuted:
      cursor == null &&
      scope.mutedOnly !== true &&
      mutedPullRules(scope).length > 0,
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
      authorType: author?.__typename,
    }),
    activity: readViewerActivity(record, commentedIds),
  };
  const labels = readLabels(record);
  if (labels.length > 0) {
    summary.labels = labels;
  }
  if (typeof record.headRefOid === 'string' && record.headRefOid !== '') {
    summary.headSha = record.headRefOid;
  }
  if (typeof record.headRefName === 'string' && record.headRefName !== '') {
    summary.headRefName = record.headRefName;
  }
  if (typeof record.id === 'string' && record.id !== '') {
    summary.nodeId = record.id;
  }
  return summary;
}

// A pull's CI and review state, read after the list itself: the head
// commit's combined check result and the branch-protection review decision.
// Either is absent when GitHub reports none.
export interface PullStatus {
  checks?: PullChecksSummary;
  reviewDecision?: PullReviewDecision;
}

// The page's CI and review state by node id. These two fields cost GitHub
// more than the list search and every other row field together (about
// 280ms a row when profiled), so the dashboard paints the rows first and
// reads these in parallel chunks of PULL_STATUS_CHUNK_SIZE afterwards.
export const PULL_STATUSES_QUERY = `query ($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      id
      reviewDecision
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
}`;

// How many pulls one status request reads. Smaller chunks run as more
// concurrent requests; the route sends all of a call's chunks at once.
export const PULL_STATUS_CHUNK_SIZE = 6;

// The most ids one /api/pull-statuses call takes: a page of the list.
export const MAX_PULL_STATUS_IDS = PULLS_PAGE_SIZE;

// GraphQL node ids as GitHub issues them: "PR_kwDO..." on github.com, base64
// ("MDExOlB1bGxSZXF1ZXN0MQ==") on older GHES.
const NODE_ID_PATTERN = /^[A-Za-z0-9_+/=-]{1,128}$/;

// A timestamp as GitHub's API reports one (updatedAt, createdAt): ISO 8601
// in UTC, e.g. 2026-08-02T09:00:00Z.
export function isGitHubTimestamp(value: string): boolean {
  return value.length <= 40 && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value);
}

export function isValidNodeId(value: string): boolean {
  return NODE_ID_PATTERN.test(value);
}

function readPullStatus(record: Record<string, unknown>): PullStatus {
  const status: PullStatus = {};
  const checks = readChecksSummary(record);
  if (checks != null) {
    status.checks = checks;
  }
  const reviewDecision = REVIEW_DECISIONS[String(record.reviewDecision)];
  if (reviewDecision != null) {
    status.reviewDecision = reviewDecision;
  }
  return status;
}

// The statuses in a PULL_STATUSES_QUERY response, by node id. Null nodes
// (pulls the token can't read) are left out, as are nodes without an id.
export function parsePullStatusesPayload(
  data: unknown
): Record<string, PullStatus> {
  const statuses: Record<string, PullStatus> = {};
  const nodes = asRecord(data)?.nodes;
  if (!Array.isArray(nodes)) {
    return statuses;
  }
  for (const node of nodes) {
    const record = asRecord(node);
    if (record != null && typeof record.id === 'string') {
      statuses[record.id] = readPullStatus(record);
    }
  }
  return statuses;
}

const REVIEW_DECISIONS: Partial<Record<string, PullReviewDecision>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  REVIEW_REQUIRED: 'review-required',
};

// The head commit's statusCheckRollup state, folded into the three results
// a list row shows: ERROR counts as a failure and EXPECTED (a required
// status that hasn't reported yet) as pending.
const CHECK_ROLLUP_STATES: Partial<Record<string, PullChecksSummary>> = {
  ERROR: 'failure',
  EXPECTED: 'pending',
  FAILURE: 'failure',
  PENDING: 'pending',
  SUCCESS: 'success',
};

function readChecksSummary(
  record: Record<string, unknown>
): PullChecksSummary | undefined {
  const commits = asRecord(record.commits)?.nodes;
  const last = Array.isArray(commits) ? commits[commits.length - 1] : null;
  const rollup = asRecord(asRecord(asRecord(last)?.commit)?.statusCheckRollup);
  return CHECK_ROLLUP_STATES[String(rollup?.state)];
}

// The state a pull shows as, in the /pulls list and the details panel alike.
// Merged and closed win over draft: a closed draft reads as closed on GitHub.
export function displayPullState(
  state: 'closed' | 'merged' | 'open',
  draft: boolean
): PullSummary['state'] {
  return state === 'open' && draft ? 'draft' : state;
}

function readPullState(record: Record<string, unknown>): PullSummary['state'] {
  if (record.state === 'MERGED') {
    return 'merged';
  }
  if (record.state === 'CLOSED') {
    return 'closed';
  }
  return displayPullState('open', record.isDraft === true);
}

function readLabels(record: Record<string, unknown>): PullLabel[] {
  return parseLabels(asRecord(record.labels)?.nodes);
}

export interface PullsPage {
  pulls: PullSummary[];
  // Search hits paged past that the viewer's GitHub App can't read; they
  // count toward totalCount but never appear in `pulls`.
  hiddenCount: number;
  totalCount: number;
  // First page only, when muted authors applied: how many more pulls the
  // search matches without their exclusions.
  mutedCount?: number;
  // Present while GitHub reports another page.
  nextCursor?: string;
  // Set when the route answered from its short-lived cache with a page past
  // its fresh window; the client shows it and refetches with no-cache.
  stale?: boolean;
}

// Reads ACTIVE_PULLS_QUERY's `data` into the page shape the dashboard
// renders. `previous` is the cursor this page was fetched with. Null nodes
// (hits the viewer's GitHub App can't read) are dropped from `pulls` but
// still paged past, so a page of only such hits keeps a cursor.
export function parseActivePullsPayload(
  data: unknown,
  previous?: PullsPageCursor
): PullsPage {
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
  const hits = nodes.map((node) => parseGraphQLPullNode(node, commentedIds));
  const pulls = hits.filter((pull): pull is PullSummary => pull != null);
  // Null nodes are hits the token can't read; malformed ones aren't.
  const hiddenCount = nodes.filter((node) => node == null).length;
  const totalCount =
    typeof pullsSearch?.issueCount === 'number'
      ? pullsSearch.issueCount
      : pulls.length;
  const page: PullsPage = { pulls, hiddenCount, totalCount };
  const unmutedCount = asRecord(asRecord(data)?.unmuted)?.issueCount;
  if (typeof unmutedCount === 'number') {
    // The two searches run a moment apart, so a pull opened in between
    // could make the difference negative.
    page.mutedCount = Math.max(0, unmutedCount - totalCount);
  }
  const pageInfo = asRecord(pullsSearch?.pageInfo);
  if (
    pageInfo?.hasNextPage === true &&
    typeof pageInfo.endCursor === 'string'
  ) {
    page.nextCursor = encodePullsCursor({
      after: pageInfo.endCursor,
      ...nextCommentedBoundary(hits, previous),
    });
  }
  return page;
}

// The next page's commented bound (the last readable updatedAt) and its
// overlap: every hit after the last readable row that is strictly beyond
// that timestamp. Rows at the timestamp and unreadable hits after it can all
// fall inside the inclusive bound; unreadable hits have no timestamp, so they
// are counted whenever they might. Overcounting only widens the subset
// fetch; undercounting would crowd out this page's Commented chips. When no
// row on this page is beyond the timestamp, earlier pages' overlap carries.
function nextCommentedBoundary(
  hits: readonly (PullSummary | undefined)[],
  previous: PullsPageCursor | undefined
): Pick<PullsPageCursor, 'boundaryRows' | 'lastUpdatedAt'> {
  const lastUpdatedAt =
    hits.findLast((hit) => hit != null)?.updatedAt ?? previous?.lastUpdatedAt;
  let boundaryRows = 0;
  for (let index = hits.length - 1; index >= 0; index--) {
    const hit = hits[index];
    if (hit != null && hit.updatedAt !== lastUpdatedAt) {
      return {
        boundaryRows: Math.min(MAX_SEARCH_RESULTS, boundaryRows),
        lastUpdatedAt,
      };
    }
    boundaryRows++;
  }
  return {
    boundaryRows: Math.min(
      MAX_SEARCH_RESULTS,
      boundaryRows + (previous?.boundaryRows ?? 0)
    ),
    lastUpdatedAt,
  };
}
