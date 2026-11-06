import { type NextRequest } from 'next/server';

import {
  commitErrorResponse,
  GitHubCommitError,
  readStringPath,
  sendGitHubGraphQL,
} from '@/lib/githubCommitServer';
import { isFullCommitSha } from '@/lib/githubDiffSource';
import { readNonEmptyString } from '@/lib/githubOAuthGrant';
import {
  type PullBodyRef,
  readPullBodyRef,
  readPullRouteParams,
} from '@/lib/githubPullDetailsServer';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseJSONBody } from '@/lib/parseJSONBody';
import type {
  PendingReviewPayload,
  RemotePendingAnchor,
  RemotePendingComment,
  RemotePendingReview,
} from '@/lib/pendingReview';
import type { PullReviewDraftComment } from '@/lib/pullCommentsClient';
import { readCommentAnchor } from '@/lib/pullReviewThreads';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';
import { asRecord } from '@/lib/untypedJson';

// The requester's pending review on a pull request, which GitHub stores
// server-side and shows only to its author. Keeping drafts there (rather than
// only in the browser) means a review started in GitHub's UI continues here
// and the reverse, and that submitting never collides with GitHub's limit of
// one pending review per author per pull request.
//
//   GET  ?owner&repo&pull → { review } (null when there is none; 401
//        without a token)
//   POST {owner, repo, pull, action, …}:
//     add     {commitId, reviewId?, comment: {path, line, side, startLine?,
//             startSide?, body}} → { reviewId, commentId }. Without
//             reviewId, finds the requester's pending review, or starts
//             one pinned to commitId.
//     edit    {commentId, body}
//     delete  {commentId}
//     submit  {reviewId, event, body} → submits the pending review
//
// Everything goes through GraphQL: it is the only API that adds a comment to
// an existing pending review, and the only one that reports a pending
// comment's lines (GitHub Enterprise's REST review-comments endpoint gives
// pending comments a diff position but no line or side). The requester's own token is
// required throughout: pending reviews are private to their author.

async function handleGET(request: NextRequest) {
  const token = await resolveBearerToken(request);
  // Without a token, "no pending review" can't be told apart from "can't
  // see it", and the client would drop every draft GitHub has saved.
  if (token == null) {
    return createJSONResponse(
      {
        error:
          'Reading a pending review requires signing in or saving a token.',
      },
      { status: 401 }
    );
  }
  const params = readPullRouteParams(request.nextUrl.searchParams);
  if (params instanceof Response) {
    return params;
  }
  const pull = toPullRef(params);
  try {
    const review = await loadPendingReview(pull, token);
    return createJSONResponse({ review } satisfies PendingReviewPayload);
  } catch (error) {
    return commitErrorResponse(error);
  }
}

async function handlePOST(request: NextRequest) {
  const token = await resolveBearerToken(request);
  if (token == null) {
    return createJSONResponse(
      { error: 'Reviewing requires signing in or saving a token.' },
      { status: 401 }
    );
  }
  const payload = await parseJSONBody(request);
  const bodyRef = readPullBodyRef(payload);
  if (payload == null || bodyRef == null) {
    return createJSONResponse(
      { error: 'owner, repo, and pull are required.' },
      { status: 400 }
    );
  }
  try {
    switch (payload.action) {
      case 'add':
        return await addComment(toPullRef(bodyRef), token, payload);
      case 'edit':
        return await editComment(token, payload);
      case 'delete':
        return await deleteComment(token, payload);
      case 'submit':
        return await submitReview(token, payload);
      default:
        return createJSONResponse(
          { error: 'action must be add, edit, delete, or submit.' },
          { status: 400 }
        );
    }
  } catch (error) {
    return commitErrorResponse(error);
  }
}

// The pull as GraphQL takes it (`number: Int`).
interface PullRef {
  number: number;
  owner: string;
  repo: string;
}

function toPullRef({ owner, pull, repo }: PullBodyRef): PullRef {
  return { number: Number(pull), owner, repo };
}

// A page of a pending review's comments: everything but their anchors.
const PENDING_COMMENT_FIELDS = `
  pageInfo { hasNextPage endCursor }
  nodes { id body replyTo { databaseId } }
`;

const PENDING_REVIEW_QUERY = `
  query PendingReview(
    $owner: String!
    $repo: String!
    $number: Int!
    $withComments: Boolean!
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        id
        reviews(states: PENDING, first: 1) {
          nodes {
            id
            commit { oid }
            comments(first: 100) @include(if: $withComments) {
              ${PENDING_COMMENT_FIELDS}
            }
          }
        }
      }
    }
  }
`;

// The pending review's comments past the first page.
const PENDING_COMMENTS_QUERY = `
  query PendingComments($id: ID!, $after: String) {
    node(id: $id) {
      ... on PullRequestReview {
        comments(first: 100, after: $after) { ${PENDING_COMMENT_FIELDS} }
      }
    }
  }
`;
const MAX_PAGES = 10;

// A pending comment as the review lists it: everything but its anchor.
interface PendingCommentBody {
  body: string;
  inReplyTo?: number;
}

// Refuses a pending review that couldn't be read in full (more comments, or
// threads, than are read; `missing` counts the unplaced comments when
// known). A partial review would be taken by reconciling as those drafts
// having been deleted, and submitting it would publish them unseen.
function incompletePendingReviewError(missing?: number): GitHubCommitError {
  const count =
    missing == null
      ? 'comments'
      : missing === 1
        ? '1 comment'
        : `${missing} comments`;
  return new GitHubCommitError(
    `Your pending review on GitHub has ${count} DiffsHub can't show in the diff (more than it reads). Submit or edit that review on GitHub.`,
    'incomplete-review',
    422
  );
}

// The cursor of a connection's next page in `direction` (its pageInfo), or
// null when it was the last.
function readPageCursor(
  connection: unknown,
  direction: 'backward' | 'forward'
): string | null {
  const pageInfo = asRecord(asRecord(connection)?.pageInfo);
  const [hasMore, cursor] =
    direction === 'forward'
      ? [pageInfo?.hasNextPage, pageInfo?.endCursor]
      : [pageInfo?.hasPreviousPage, pageInfo?.startCursor];
  return hasMore === true && typeof cursor === 'string' ? cursor : null;
}

// Adds a page of pending comments (PENDING_COMMENT_FIELDS) to `into`.
function readPendingCommentPage(
  connection: unknown,
  into: Map<string, PendingCommentBody>
): void {
  const nodes = asRecord(connection)?.nodes;
  for (const value of Array.isArray(nodes) ? nodes : []) {
    const comment = asRecord(value);
    const replyTo = asRecord(comment?.replyTo)?.databaseId;
    if (typeof comment?.id === 'string' && typeof comment.body === 'string') {
      into.set(comment.id, {
        body: comment.body,
        inReplyTo: typeof replyTo === 'number' ? replyTo : undefined,
      });
    }
  }
}

// The pull request's node id and the requester's pending review on it, if
// any, with the first page of its comments (PENDING_COMMENT_FIELDS) when
// `withComments`. GitHub lists a PENDING review only to its author, so
// `first: 1` is the requester's.
async function findPendingReview(
  pull: PullRef,
  token: string,
  withComments = false
): Promise<{
  pullRequestId: string;
  review: { commitId: string; firstComments: unknown; id: string } | null;
}> {
  const data = await sendGitHubGraphQL(
    PENDING_REVIEW_QUERY,
    { ...pull, withComments },
    token
  );
  const pullRequest = asRecord(
    asRecord(asRecord(data)?.repository)?.pullRequest
  );
  const pullRequestId = pullRequest?.id;
  if (typeof pullRequestId !== 'string') {
    throw new GitHubCommitError('Pull request not found.', 'github', 404);
  }
  const node = asRecord(
    (asRecord(pullRequest?.reviews)?.nodes as unknown[] | undefined)?.[0]
  );
  const id = node?.id;
  const commitId = readStringPath(node, ['commit', 'oid']);
  return {
    pullRequestId,
    review:
      typeof id === 'string' && commitId != null
        ? { commitId, firstComments: node?.comments, id }
        : null,
  };
}

// Review threads' anchors and comment ids, newest first: a pending comment's
// lines and side live on its thread (a pending reply sits in an existing
// thread and shares its anchor), and new pending threads are the newest. A
// thread's last 100 comments are read: pending replies are its newest.
const REVIEW_THREADS_QUERY = `
  query ReviewThreads(
    $owner: String!
    $repo: String!
    $number: Int!
    $before: String
  ) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviewThreads(last: 100, before: $before) {
          pageInfo { hasPreviousPage startCursor }
          nodes {
            path
            diffSide
            startDiffSide
            line
            startLine
            originalLine
            originalStartLine
            subjectType
            comments(last: 100) { nodes { id } }
          }
        }
      }
    }
  }
`;

// The requester's pending review with its comments' anchors: the review and
// its comments' bodies (paged), then the PR's review threads, paged only
// until every pending comment is placed. Throws an 'incomplete-review'
// error when not every comment could be read and placed.
async function loadPendingReview(
  pull: PullRef,
  token: string
): Promise<RemotePendingReview | null> {
  const { review } = await findPendingReview(pull, token, true);
  if (review == null) {
    return null;
  }
  const bodies = new Map<string, PendingCommentBody>();
  readPendingCommentPage(review.firstComments, bodies);
  let cursor = readPageCursor(review.firstComments, 'forward');
  for (let page = 1; cursor != null; page += 1) {
    if (page >= MAX_PAGES) {
      throw incompletePendingReviewError();
    }
    const connection = asRecord(
      asRecord(
        await sendGitHubGraphQL(
          PENDING_COMMENTS_QUERY,
          { after: cursor, id: review.id },
          token
        )
      )?.node
    )?.comments;
    readPendingCommentPage(connection, bodies);
    cursor = readPageCursor(connection, 'forward');
  }
  const comments: RemotePendingComment[] = [];
  let before: string | null = null;
  for (
    let page = 0;
    page < MAX_PAGES && comments.length < bodies.size;
    page += 1
  ) {
    const threads = asRecord(
      asRecord(
        asRecord(
          asRecord(
            await sendGitHubGraphQL(
              REVIEW_THREADS_QUERY,
              { ...pull, before },
              token
            )
          )?.repository
        )?.pullRequest
      )?.reviewThreads
    );
    const nodes = Array.isArray(threads?.nodes) ? threads.nodes : [];
    for (const thread of nodes) {
      comments.push(...readPendingThreadComments(thread, bodies));
    }
    before = readPageCursor(threads, 'backward');
    if (before == null) {
      break;
    }
  }
  if (comments.length < bodies.size) {
    throw incompletePendingReviewError(bodies.size - comments.length);
  }
  return { commitId: review.commitId, comments, id: review.id };
}

// Where a review thread sits: its lines (the original ones once outdated),
// or the whole file. GitHub reports a line (1) for file-level threads too,
// which is ignored.
function readThreadAnchor(
  thread: Record<string, unknown> | null
): RemotePendingAnchor | null {
  if (thread?.subjectType !== 'FILE') {
    return readCommentAnchor({
      line: thread?.line ?? thread?.originalLine,
      path: thread?.path,
      side: thread?.diffSide,
      startLine: thread?.startLine ?? thread?.originalStartLine,
      startSide: thread?.startDiffSide,
    });
  }
  return typeof thread.path === 'string' && thread.path !== ''
    ? { path: thread.path, subjectType: 'file' }
    : null;
}

// A review thread's comments that are among the pending review's
// `pending`, anchored where the thread is.
function readPendingThreadComments(
  thread: unknown,
  pending: ReadonlyMap<string, PendingCommentBody>
): RemotePendingComment[] {
  const record = asRecord(thread);
  const anchor = readThreadAnchor(record);
  const nodes = asRecord(record?.comments)?.nodes;
  if (anchor == null || !Array.isArray(nodes)) {
    return [];
  }
  return nodes.flatMap((node) => {
    const id = asRecord(node)?.id;
    if (typeof id !== 'string') {
      return [];
    }
    const comment = pending.get(id);
    return comment == null ? [] : [{ ...anchor, ...comment, id }];
  });
}

const ADD_REVIEW_MUTATION = `
  mutation StartReview($pullRequestId: ID!, $commitOID: GitObjectID!) {
    addPullRequestReview(
      input: { pullRequestId: $pullRequestId, commitOID: $commitOID }
    ) {
      pullRequestReview { id }
    }
  }
`;

const ADD_THREAD_MUTATION = `
  mutation AddDraft(
    $reviewId: ID!
    $path: String!
    $body: String!
    $line: Int!
    $side: DiffSide!
    $startLine: Int
    $startSide: DiffSide
  ) {
    addPullRequestReviewThread(
      input: {
        pullRequestReviewId: $reviewId
        path: $path
        body: $body
        line: $line
        side: $side
        startLine: $startLine
        startSide: $startSide
      }
    ) {
      thread { comments(first: 1) { nodes { id } } }
    }
  }
`;

// The requester's pending review to add a draft to, started (pinned to
// `commitId`) when there is none. An existing review pinned to another
// commit refuses the draft: its line numbers describe a different diff.
async function findOrStartReview(
  pull: PullRef,
  token: string,
  commitId: string
): Promise<string> {
  const found = await findPendingReview(pull, token);
  if (found.review != null) {
    if (found.review.commitId !== commitId) {
      throw new GitHubCommitError(
        'Your pending review is on an earlier push of this pull request.',
        'stale-review',
        409
      );
    }
    return found.review.id;
  }
  const started = await sendGitHubGraphQL(
    ADD_REVIEW_MUTATION,
    { commitOID: commitId, pullRequestId: found.pullRequestId },
    token
  );
  const reviewId = readStringPath(started, [
    'addPullRequestReview',
    'pullRequestReview',
    'id',
  ]);
  if (reviewId == null) {
    throw new GitHubCommitError(
      'GitHub did not start the review.',
      'github',
      502
    );
  }
  return reviewId;
}

// Adds one draft comment to the requester's pending review (see
// findOrStartReview).
async function addComment(
  pull: PullRef,
  token: string,
  payload: Record<string, unknown>
): Promise<Response> {
  const comment = asRecord(payload.comment);
  const commitId = payload.commitId;
  const anchor = comment == null ? null : readAnchor(comment);
  if (anchor == null || !isFullCommitSha(commitId)) {
    return createJSONResponse(
      {
        error:
          'A draft needs commitId and {path, line, side, body} (startLine and startSide optional).',
      },
      { status: 400 }
    );
  }
  // A client that already knows its pending review (and so its commit)
  // passes the id, saving the lookup on every draft after the first.
  const reviewId =
    typeof payload.reviewId === 'string'
      ? payload.reviewId
      : await findOrStartReview(pull, token, commitId);
  const added = await sendGitHubGraphQL(
    ADD_THREAD_MUTATION,
    { ...anchor, reviewId },
    token
  );
  const commentId = readStringPath(added, [
    'addPullRequestReviewThread',
    'thread',
    'comments',
    'nodes',
    '0',
    'id',
  ]);
  if (commentId == null) {
    throw new GitHubCommitError(
      'GitHub did not save the draft comment.',
      'github',
      502
    );
  }
  return createJSONResponse({ commentId, reviewId });
}

async function editComment(
  token: string,
  payload: Record<string, unknown>
): Promise<Response> {
  const { body, commentId } = payload;
  if (typeof commentId !== 'string' || readNonEmptyString(body) == null) {
    return createJSONResponse(
      { error: 'commentId and a non-empty body are required.' },
      { status: 400 }
    );
  }
  await sendGitHubGraphQL(
    `mutation EditDraft($id: ID!, $body: String!) {
      updatePullRequestReviewComment(
        input: { pullRequestReviewCommentId: $id, body: $body }
      ) { pullRequestReviewComment { id } }
    }`,
    { body, id: commentId },
    token
  );
  return createJSONResponse({ ok: true });
}

async function deleteComment(
  token: string,
  payload: Record<string, unknown>
): Promise<Response> {
  const { commentId } = payload;
  if (typeof commentId !== 'string') {
    return createJSONResponse(
      { error: 'commentId is required.' },
      { status: 400 }
    );
  }
  await sendGitHubGraphQL(
    `mutation DeleteDraft($id: ID!) {
      deletePullRequestReviewComment(input: { id: $id }) {
        pullRequestReview { id }
      }
    }`,
    { id: commentId },
    token
  );
  return createJSONResponse({ ok: true });
}

const REVIEW_EVENTS = new Set(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']);

async function submitReview(
  token: string,
  payload: Record<string, unknown>
): Promise<Response> {
  const { event, reviewId } = payload;
  const body = typeof payload.body === 'string' ? payload.body : '';
  if (
    typeof reviewId !== 'string' ||
    typeof event !== 'string' ||
    !REVIEW_EVENTS.has(event)
  ) {
    return createJSONResponse(
      {
        error:
          'reviewId and an event of APPROVE, REQUEST_CHANGES, or COMMENT are required.',
      },
      { status: 400 }
    );
  }
  await sendGitHubGraphQL(
    `mutation SubmitReview(
      $id: ID!
      $event: PullRequestReviewEvent!
      $body: String
    ) {
      submitPullRequestReview(
        input: { pullRequestReviewId: $id, event: $event, body: $body }
      ) { pullRequestReview { id } }
    }`,
    { body, event, id: reviewId },
    token
  );
  return createJSONResponse({ ok: true });
}

// The GraphQL variables for a draft's anchor and text.
function readAnchor(
  record: Record<string, unknown>
): PullReviewDraftComment | null {
  const anchor = readCommentAnchor({
    line: record.line,
    path: record.path,
    side: record.side,
    startLine: record.startLine,
    startSide: record.startSide,
  });
  return anchor == null || readNonEmptyString(record.body) == null
    ? null
    : { ...anchor, body: record.body as string };
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
