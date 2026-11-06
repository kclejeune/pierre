import { type NextRequest } from 'next/server';

import { sendGitHubGraphQL } from '@/lib/githubCommitServer';
import { isFullCommitSha } from '@/lib/githubDiffSource';
import {
  createGitHubAPIURL,
  createGitHubJSONHeaders,
  getGitHubEnvironment,
  type GitHubEnvironment,
  rejectTokenlessRequestWhenLoginRequired,
} from '@/lib/githubEnvironment';
import { githubFetch } from '@/lib/githubFetch';
import { fetchPagesInParallel, parseLastPage } from '@/lib/githubPagination';
import {
  createGitHubFailureResponse,
  createUnreachableResponse,
  readGitHubJSON,
} from '@/lib/githubProxyResponse';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseJSONBody } from '@/lib/parseJSONBody';
import {
  isFileCommentAnchor,
  isGitHubDiffSide,
  readCommentAnchor,
} from '@/lib/pullReviewThreads';
import {
  type CommentReaction,
  readReactionGroups,
  readRestReactions,
} from '@/lib/reactions';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';
import type { PullDiscussionComment, PullReviewComment } from '@/lib/types';
import { asRecord } from '@/lib/untypedJson';

// Proxies GitHub pull-request review comments for the configured instance:
//   GET    ?owner&repo&pull            → all review comments plus PR-level
//                                        discussion (issue comments and
//                                        review summaries), normalized
//   POST   {owner, repo, pull, body, inReplyToId}          → reply to a thread
//   POST   {owner, repo, pull, body, path, line, side, …}  → new comment
//          (optional commitId: the head commit the anchor was read from)
//   POST   {owner, repo, pull, body, discussion: true}     → new PR-level comment
//   POST   {owner, repo, pull, review: true, event, body, comments,
//          commitId?} → submit a review: verdict (APPROVE / REQUEST_CHANGES /
//          COMMENT), optional summary body, and the batched inline comments,
//          in one call
//   PATCH  {owner, repo, commentId, body}                  → edit a comment
//   PATCH  {owner, repo, commentId, body, discussion: true} → edit PR-level
//   DELETE ?owner&repo&commentId                           → delete a comment
//   DELETE ?owner&repo&commentId&discussion=true           → delete PR-level
//
// "PR-level" writes target the pull request's conversation (GitHub issue
// comments) rather than diff-anchored review comments. Review summaries are
// read-only here: GitHub only permits deleting pending reviews, and editing
// them goes through a different review-scoped endpoint.
//
// Reads act with the requester's token when one is sent and anonymously
// otherwise (public-repo threads on github.com). Writes always require the
// requester's own token.

const MAX_COMMENT_PAGES = 10;
const PER_PAGE = 100;

async function handleGET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }

  const params = request.nextUrl.searchParams;
  const owner = params.get('owner');
  const repo = params.get('repo');
  const pull = params.get('pull');
  if (!isValidSegment(owner) || !isValidSegment(repo) || !isValidNumber(pull)) {
    return createJSONResponse(
      { error: 'owner, repo, and pull parameters are required.' },
      { status: 400 }
    );
  }

  const token = await resolveBearerToken(request);
  const environment = getGitHubEnvironment();

  // Review comments are the core payload — their failures fail the request.
  // The PR-level discussion (issue comments, review summaries) is best-effort
  // extra context: any failure there degrades to an empty list rather than
  // blocking the inline threads.
  // Review summaries' reactions come from GraphQL alongside the REST reads:
  // REST reports no tallies on reviews.
  const [reviewResult, issueResult, reviewsResult, reviewReactions] =
    await Promise.all([
      fetchAllPages(
        environment,
        `/repos/${owner}/${repo}/pulls/${pull}/comments`,
        token,
        request.signal
      ).catch(() => 'unreachable' as const),
      fetchAllPages(
        environment,
        `/repos/${owner}/${repo}/issues/${pull}/comments`,
        token,
        request.signal
      ).catch(() => null),
      fetchAllPages(
        environment,
        `/repos/${owner}/${repo}/pulls/${pull}/reviews`,
        token,
        request.signal
      ).catch(() => null),
      token == null
        ? null
        : fetchReviewReactions(owner, repo, Number(pull), token).catch(
            () => null
          ),
    ]);
  if (reviewResult === 'unreachable') {
    return createUnreachableResponse(environment);
  }
  if ('failure' in reviewResult) {
    return reviewResult.failure;
  }

  // The requester's pending comments belong to the pending batch (shown as
  // pending cards), not the published threads. GitHub Enterprise leaves them
  // out of this list; this drops them should an instance include them.
  const pendingReviewIds = new Set(
    reviewsResult != null && 'records' in reviewsResult
      ? reviewsResult.records.flatMap((record) => {
          const review = asRecord(record);
          return review?.state === 'PENDING' && typeof review.id === 'number'
            ? [review.id]
            : [];
        })
      : []
  );
  const comments: PullReviewComment[] = [];
  for (const record of reviewResult.records) {
    const reviewId = asRecord(record)?.pull_request_review_id;
    if (typeof reviewId === 'number' && pendingReviewIds.has(reviewId)) {
      continue;
    }
    const normalized = normalizeReviewComment(record);
    if (normalized != null) {
      comments.push(normalized);
    }
  }

  const discussion: PullDiscussionComment[] = [];
  if (issueResult != null && 'records' in issueResult) {
    for (const record of issueResult.records) {
      const normalized = normalizeDiscussionComment(record);
      if (normalized != null) {
        discussion.push(normalized);
      }
    }
  }
  if (reviewsResult != null && 'records' in reviewsResult) {
    for (const record of reviewsResult.records) {
      const normalized = normalizeReviewSummary(record);
      if (normalized != null) {
        discussion.push(normalized);
      }
    }
  }
  discussion.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (token != null) {
    await addViewerReactions(comments, discussion, reviewReactions, token);
  }

  return createJSONResponse({ comments, discussion });
}

// Fetches every page of a GitHub list endpoint (capped at MAX_COMMENT_PAGES).
// Page 1's Link header reports the total page count, so the remaining pages
// fan out in parallel. The signal aborts the calls when the browser abandons
// the request instead of paginating to completion against a dead client.
async function fetchAllPages(
  environment: GitHubEnvironment,
  pathname: string,
  token: string | undefined,
  signal: AbortSignal
): Promise<{ records: unknown[] } | { failure: Response }> {
  const fetchPage = (page: number) =>
    githubFetch(
      createGitHubAPIURL(environment, pathname, {
        page: String(page),
        per_page: String(PER_PAGE),
      }),
      { cache: 'no-store', headers: buildGitHubHeaders(token), signal }
    );

  // Each page parsed as it arrives; a failed page reports a last page of 1
  // so page 1's failure stops the walk.
  const readPage = async (page: number) => {
    const response = await fetchPage(page);
    if (!response.ok) {
      return {
        failure: await createGitHubFailureResponse(response),
        lastPage: 1,
      };
    }
    const parsed = await readGitHubJSON(response);
    return parsed.failure != null
      ? { failure: parsed.failure, lastPage: 1 }
      : {
          lastPage: parseLastPage(response.headers.get('link')),
          records: parsed.data as unknown[],
        };
  };
  const pages = await fetchPagesInParallel(
    readPage,
    (first) => first.lastPage,
    MAX_COMMENT_PAGES
  );
  const records: unknown[] = [];
  for (const page of pages) {
    if (page.failure != null) {
      return { failure: page.failure };
    }
    records.push(...page.records);
  }
  return { records };
}

async function handlePOST(request: NextRequest) {
  const token = await resolveBearerToken(request);
  if (token == null) {
    return createJSONResponse(
      { error: 'Posting a comment requires signing in or saving a token.' },
      { status: 401 }
    );
  }

  const payload = await parseJSONBody(request);
  const owner = payload?.owner;
  const repo = payload?.repo;
  const pull = payload?.pull;
  if (!isValidSegment(owner) || !isValidSegment(repo) || !isValidNumber(pull)) {
    return createJSONResponse(
      { error: 'owner, repo, and pull are required.' },
      { status: 400 }
    );
  }

  const environment = getGitHubEnvironment();

  // Review submission allows an empty body (a bare approval), so it validates
  // before the shared non-empty body check the comment branches rely on.
  if (payload?.review === true) {
    return await submitReview(environment, token, owner, repo, pull, payload);
  }

  const body = payload?.body;
  if (typeof body !== 'string' || body.trim() === '') {
    return createJSONResponse(
      { error: 'A non-empty body is required.' },
      { status: 400 }
    );
  }

  const inReplyToId = payload?.inReplyToId;
  try {
    if (payload?.discussion === true) {
      return await forwardNormalizedResponse(
        await githubFetch(
          createGitHubAPIURL(
            environment,
            `/repos/${owner}/${repo}/issues/${pull}/comments`
          ),
          {
            method: 'POST',
            headers: buildGitHubHeaders(token),
            body: JSON.stringify({ body }),
          }
        ),
        normalizeDiscussionComment
      );
    }

    if (typeof inReplyToId === 'number') {
      return await forwardNormalizedResponse(
        await githubFetch(
          createGitHubAPIURL(
            environment,
            `/repos/${owner}/${repo}/pulls/${pull}/comments/${inReplyToId}/replies`
          ),
          {
            method: 'POST',
            headers: buildGitHubHeaders(token),
            body: JSON.stringify({ body }),
          }
        ),
        normalizeReviewComment
      );
    }

    const anchor = parseCommentAnchor(payload ?? {});
    if (anchor == null) {
      return createJSONResponse(
        {
          error:
            "path, line, and side (or subjectType 'file') are required for a new comment.",
        },
        { status: 400 }
      );
    }

    // GitHub resolves line/side against the diff at commit_id, so anchor to
    // the head the client's diff was rendered from when it sends one; a newer
    // head would reject (422) any line the author has since changed.
    const requestedCommitId = payload?.commitId;
    const commitId = isFullCommitSha(requestedCommitId)
      ? requestedCommitId
      : await resolvePullHeadCommit(environment, token, owner, repo, pull);
    if (typeof commitId !== 'string') {
      return commitId;
    }

    return await forwardNormalizedResponse(
      await githubFetch(
        createGitHubAPIURL(
          environment,
          `/repos/${owner}/${repo}/pulls/${pull}/comments`
        ),
        {
          method: 'POST',
          headers: buildGitHubHeaders(token),
          body: JSON.stringify({ ...anchor, body, commit_id: commitId }),
        }
      ),
      normalizeReviewComment
    );
  } catch {
    return createUnreachableResponse(environment);
  }
}

async function handlePATCH(request: NextRequest) {
  const token = await resolveBearerToken(request);
  if (token == null) {
    return createJSONResponse(
      { error: 'Editing a comment requires signing in or saving a token.' },
      { status: 401 }
    );
  }

  const payload = await parseJSONBody(request);
  const owner = payload?.owner;
  const repo = payload?.repo;
  const commentId = payload?.commentId;
  const body = payload?.body;
  if (
    !isValidSegment(owner) ||
    !isValidSegment(repo) ||
    typeof commentId !== 'number' ||
    typeof body !== 'string' ||
    body.trim() === ''
  ) {
    return createJSONResponse(
      { error: 'owner, repo, commentId, and a non-empty body are required.' },
      { status: 400 }
    );
  }

  const environment = getGitHubEnvironment();
  const isDiscussion = payload?.discussion === true;
  const editPathname = isDiscussion
    ? `/repos/${owner}/${repo}/issues/comments/${commentId}`
    : `/repos/${owner}/${repo}/pulls/comments/${commentId}`;
  try {
    const response = await githubFetch(
      createGitHubAPIURL(environment, editPathname),
      {
        method: 'PATCH',
        headers: buildGitHubHeaders(token),
        body: JSON.stringify({ body }),
      }
    );
    return await forwardNormalizedResponse(
      response,
      isDiscussion ? normalizeDiscussionComment : normalizeReviewComment
    );
  } catch {
    return createUnreachableResponse(environment);
  }
}

async function handleDELETE(request: NextRequest) {
  const token = await resolveBearerToken(request);
  if (token == null) {
    return createJSONResponse(
      { error: 'Deleting a comment requires signing in or saving a token.' },
      { status: 401 }
    );
  }

  const params = request.nextUrl.searchParams;
  const owner = params.get('owner');
  const repo = params.get('repo');
  const commentId = params.get('commentId');
  if (
    !isValidSegment(owner) ||
    !isValidSegment(repo) ||
    !isValidNumber(commentId)
  ) {
    return createJSONResponse(
      { error: 'owner, repo, and commentId parameters are required.' },
      { status: 400 }
    );
  }

  const environment = getGitHubEnvironment();
  const deletePathname =
    params.get('discussion') === 'true'
      ? `/repos/${owner}/${repo}/issues/comments/${commentId}`
      : `/repos/${owner}/${repo}/pulls/comments/${commentId}`;
  try {
    const response = await githubFetch(
      createGitHubAPIURL(environment, deletePathname),
      { method: 'DELETE', headers: buildGitHubHeaders(token) }
    );
    if (!response.ok) {
      return createGitHubFailureResponse(response);
    }
    return createJSONResponse({ deleted: true });
  } catch {
    return createUnreachableResponse(environment);
  }
}

const REVIEW_EVENTS = new Set(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);

// Creates and submits a pull-request review in one call: the verdict, an
// optional summary body, and the batched inline comments. GitHub creates a
// PENDING review only when `event` is omitted, so always sending it means no
// server-side draft state is ever left behind.
async function submitReview(
  environment: GitHubEnvironment,
  token: string,
  owner: string,
  repo: string,
  pull: string,
  payload: Record<string, unknown>
): Promise<Response> {
  const event = payload.event;
  const body = typeof payload.body === 'string' ? payload.body : '';
  if (typeof event !== 'string' || !REVIEW_EVENTS.has(event)) {
    return createJSONResponse(
      { error: 'event must be APPROVE, REQUEST_CHANGES, or COMMENT.' },
      { status: 400 }
    );
  }
  const comments = normalizeReviewDraftComments(payload.comments);
  if (comments == null) {
    return createJSONResponse(
      { error: 'comments must be {path, line, side, body} entries.' },
      { status: 400 }
    );
  }
  if (event === 'COMMENT' && body.trim() === '' && comments.length === 0) {
    return createJSONResponse(
      { error: 'A comment review needs a summary or at least one comment.' },
      { status: 400 }
    );
  }

  try {
    const requestedCommitId = payload.commitId;
    const commitId = isFullCommitSha(requestedCommitId)
      ? requestedCommitId
      : await resolvePullHeadCommit(environment, token, owner, repo, pull);
    if (typeof commitId !== 'string') {
      return commitId;
    }
    const response = await githubFetch(
      createGitHubAPIURL(
        environment,
        `/repos/${owner}/${repo}/pulls/${pull}/reviews`
      ),
      {
        method: 'POST',
        headers: buildGitHubHeaders(token),
        body: JSON.stringify({
          body,
          comments: comments.length > 0 ? comments : undefined,
          commit_id: commitId,
          event,
        }),
      }
    );
    if (!response.ok) {
      return createGitHubFailureResponse(response);
    }
    const parsed = await readGitHubJSON(response);
    if (parsed.failure != null) {
      return parsed.failure;
    }
    // May be null for a bodiless COMMENTED review (dropped from the
    // discussion feed by design); the client refetches comments regardless.
    return createJSONResponse({
      review: normalizeReviewSummary(parsed.data),
    });
  } catch {
    return createUnreachableResponse(environment);
  }
}

// Validates the batched inline comments for a review submission, mapping them
// to GitHub's snake_case anchor fields. Returns null when any entry is
// malformed so the route can reject the whole batch.
function normalizeReviewDraftComments(
  value: unknown
): Record<string, unknown>[] | null {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const comments: Record<string, unknown>[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry == null) {
      return null;
    }
    const record = entry as Record<string, unknown>;
    const anchor = parseCommentAnchor(record);
    const body = record.body;
    if (anchor == null || typeof body !== 'string' || body.trim() === '') {
      return null;
    }
    comments.push({ ...anchor, body });
  }
  return comments;
}

// Validates the diff-anchor fields GitHub requires of a review comment —
// path, line, side, and the optional multi-line start anchor — and maps them
// to GitHub's snake_case request fields. GitHub rejects start_line equal to
// line, so a start anchor is only emitted for genuinely multi-line comments.
// Returns null when the anchor is malformed; callers add body / commit_id.
function parseCommentAnchor(
  record: Record<string, unknown>
): Record<string, unknown> | null {
  const anchor = readCommentAnchor(record);
  if (anchor == null) {
    return null;
  }
  if (isFileCommentAnchor(anchor)) {
    return { path: anchor.path, subject_type: 'file' };
  }
  const { line, path, side, startLine, startSide } = anchor;
  return startLine == null
    ? { line, path, side }
    : { line, path, side, start_line: startLine, start_side: startSide };
}

// Resolves the pull's current head commit, or a ready-to-return failure
// Response when GitHub refuses or answers with an unexpected shape.
async function resolvePullHeadCommit(
  environment: GitHubEnvironment,
  token: string,
  owner: string,
  repo: string,
  pull: string
): Promise<string | Response> {
  const pullResponse = await githubFetch(
    createGitHubAPIURL(environment, `/repos/${owner}/${repo}/pulls/${pull}`),
    { cache: 'no-store', headers: buildGitHubHeaders(token) }
  );
  if (!pullResponse.ok) {
    return createGitHubFailureResponse(pullResponse);
  }
  const parsedPull = await readGitHubJSON(pullResponse);
  if (parsedPull.failure != null) {
    return parsedPull.failure;
  }
  const pullData = parsedPull.data as {
    head?: { sha?: unknown };
  };
  const commitId = pullData.head?.sha;
  if (typeof commitId !== 'string') {
    return createJSONResponse(
      { error: 'Could not resolve the pull request head commit.' },
      { status: 502 }
    );
  }
  return commitId;
}

// Normalizes a GitHub review-comment payload into the app's shape, dropping
// entries that lack the fields the viewer depends on.
function normalizeReviewComment(comment: unknown): PullReviewComment | null {
  if (typeof comment !== 'object' || comment == null) {
    return null;
  }
  const record = comment as Record<string, unknown>;
  const user = record.user as Record<string, unknown> | null | undefined;
  if (
    typeof record.id !== 'number' ||
    typeof record.body !== 'string' ||
    typeof record.path !== 'string' ||
    typeof record.created_at !== 'string' ||
    typeof user?.login !== 'string'
  ) {
    return null;
  }

  return {
    author: {
      avatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url : '',
      login: user.login,
    },
    body: record.body,
    createdAt: record.created_at,
    htmlUrl: typeof record.html_url === 'string' ? record.html_url : null,
    id: record.id,
    inReplyToId:
      typeof record.in_reply_to_id === 'number' ? record.in_reply_to_id : null,
    line: typeof record.line === 'number' ? record.line : null,
    ...readReactionFields(record),
    path: record.path,
    side: isGitHubDiffSide(record.side) ? record.side : null,
    startLine: typeof record.start_line === 'number' ? record.start_line : null,
    startSide: isGitHubDiffSide(record.start_side) ? record.start_side : null,
    ...(record.subject_type === 'file' ? { subjectType: 'file' as const } : {}),
  };
}

// An issue comment on the PR's conversation tab.
function normalizeDiscussionComment(
  comment: unknown
): PullDiscussionComment | null {
  if (typeof comment !== 'object' || comment == null) {
    return null;
  }
  const record = comment as Record<string, unknown>;
  const user = record.user as Record<string, unknown> | null | undefined;
  if (
    typeof record.id !== 'number' ||
    typeof record.body !== 'string' ||
    typeof record.created_at !== 'string' ||
    typeof user?.login !== 'string'
  ) {
    return null;
  }
  return {
    author: {
      avatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url : '',
      login: user.login,
    },
    body: record.body,
    createdAt: record.created_at,
    htmlUrl: typeof record.html_url === 'string' ? record.html_url : null,
    id: record.id,
    kind: 'comment',
    ...readReactionFields(record),
    reviewState: null,
  };
}

// A submitted review's summary. PENDING reviews are private to their author
// and dropped; bodiless COMMENTED reviews are containers for inline comments
// already shown as threads, so only verdicts (approve / request changes)
// survive without a body.
function normalizeReviewSummary(review: unknown): PullDiscussionComment | null {
  if (typeof review !== 'object' || review == null) {
    return null;
  }
  const record = review as Record<string, unknown>;
  const user = record.user as Record<string, unknown> | null | undefined;
  const state = typeof record.state === 'string' ? record.state : '';
  const body = typeof record.body === 'string' ? record.body : '';
  if (
    typeof record.id !== 'number' ||
    typeof record.submitted_at !== 'string' ||
    typeof user?.login !== 'string' ||
    state === '' ||
    state === 'PENDING' ||
    (body.trim() === '' &&
      state !== 'APPROVED' &&
      state !== 'CHANGES_REQUESTED')
  ) {
    return null;
  }
  return {
    author: {
      avatarUrl: typeof user.avatar_url === 'string' ? user.avatar_url : '',
      login: user.login,
    },
    body,
    createdAt: record.submitted_at,
    htmlUrl: typeof record.html_url === 'string' ? record.html_url : null,
    id: record.id,
    kind: 'review',
    ...readReactionFields(record),
    reviewState: state,
  };
}

// Relays a GitHub create/edit response back to the browser as a normalized
// comment (review or PR-level, depending on the normalizer), preserving
// failure details for actionable error messages.
async function forwardNormalizedResponse(
  response: Response,
  normalize: (
    payload: unknown
  ) => PullReviewComment | PullDiscussionComment | null
): Promise<Response> {
  if (!response.ok) {
    return createGitHubFailureResponse(response);
  }
  const parsed = await readGitHubJSON(response);
  if (parsed.failure != null) {
    return parsed.failure;
  }
  const comment = normalize(parsed.data);
  if (comment == null) {
    return createJSONResponse(
      { error: 'GitHub returned an unexpected comment payload.' },
      { status: 502 }
    );
  }
  return createJSONResponse({ comment });
}

// A REST comment's node id and reaction tallies. Review summaries carry no
// tallies over REST; the viewer-state pass below fills them in.
function readReactionFields(record: Record<string, unknown>): {
  nodeId?: string;
  reactions: CommentReaction[];
} {
  return {
    ...(typeof record.node_id === 'string' ? { nodeId: record.node_id } : {}),
    reactions: readRestReactions(record.reactions),
  };
}

// A Reactable's reactions, with which are the viewer's.
const REACTION_FIELDS = `
  id
  reactionGroups {
    content
    viewerHasReacted
    reactors { totalCount }
  }
`;

const REACTIONS_QUERY = `query ($ids: [ID!]!) {
  nodes(ids: $ids) { ... on Reactable { ${REACTION_FIELDS} } }
}`;
const REACTIONS_BATCH = 100;

const REVIEW_REACTIONS_QUERY = `query ($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(first: 100) { nodes { ${REACTION_FIELDS} } }
    }
  }
}`;

// The pull request's review summaries' reactions by review node id. Reviews
// past the first 100 are absent.
async function fetchReviewReactions(
  owner: string,
  repo: string,
  number: number,
  token: string
): Promise<Map<string, CommentReaction[]>> {
  const data = asRecord(
    await sendGitHubGraphQL(
      REVIEW_REACTIONS_QUERY,
      { number, owner, repo },
      token
    )
  );
  const reviews = asRecord(
    asRecord(asRecord(data?.repository)?.pullRequest)?.reviews
  );
  return readReactionNodes(reviews?.nodes);
}

// Reactable nodes' reactions by node id, skipping malformed ones.
function readReactionNodes(nodes: unknown): Map<string, CommentReaction[]> {
  const byId = new Map<string, CommentReaction[]>();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const record = asRecord(node);
    const reactions = readReactionGroups(record?.reactionGroups);
    if (typeof record?.id === 'string' && reactions != null) {
      byId.set(record.id, reactions);
    }
  }
  return byId;
}

// Replaces tallies with GitHub's GraphQL view of them, which also says which
// reactions are the viewer's: review summaries from `reviewReactions`
// (fetched alongside the REST reads; REST reports none for reviews), and
// comments GitHub reports reactions on in one more request (comments without
// any need none, so it is usually skipped). Anything GraphQL couldn't answer
// for (an older GitHub Enterprise without ReactionGroup.reactors, a token
// without GraphQL access) keeps its REST tallies and is marked
// reactionsViewerUnknown.
async function addViewerReactions(
  comments: readonly PullReviewComment[],
  discussion: readonly PullDiscussionComment[],
  reviewReactions: ReadonlyMap<string, CommentReaction[]> | null,
  token: string
): Promise<void> {
  const pending = new Map<string, PullReviewComment | PullDiscussionComment>();
  const reactedIds: string[] = [];
  for (const comment of [...comments, ...discussion]) {
    const isReview = 'kind' in comment && comment.kind === 'review';
    if (
      comment.nodeId != null &&
      (isReview || (comment.reactions?.length ?? 0) > 0)
    ) {
      pending.set(comment.nodeId, comment);
      if (!isReview) {
        reactedIds.push(comment.nodeId);
      }
    }
  }
  const batches: string[][] = [];
  for (let index = 0; index < reactedIds.length; index += REACTIONS_BATCH) {
    batches.push(reactedIds.slice(index, index + REACTIONS_BATCH));
  }
  const results = await Promise.all(
    batches.map((batch) =>
      sendGitHubGraphQL(REACTIONS_QUERY, { ids: batch }, token)
        .then((data) => readReactionNodes(asRecord(data)?.nodes))
        .catch(() => null)
    )
  );
  const resolved = new Map(
    [reviewReactions, ...results].flatMap((result) =>
      result == null ? [] : [...result]
    )
  );
  for (const [nodeId, comment] of pending) {
    const reactions = resolved.get(nodeId);
    if (reactions == null) {
      comment.reactionsViewerUnknown = true;
    } else {
      comment.reactions = reactions;
    }
  }
}

function buildGitHubHeaders(token: string | undefined): HeadersInit {
  return {
    ...createGitHubJSONHeaders(token),
    'Content-Type': 'application/json',
  };
}

function isValidSegment(value: unknown): value is string {
  return typeof value === 'string' && /^[\w.-]+$/.test(value);
}

function isValidNumber(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
export const PATCH = withRequestLog(handlePATCH);
export const DELETE = withRequestLog(handleDELETE);
