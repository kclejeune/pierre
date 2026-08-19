import { type NextRequest } from 'next/server';

import {
  createGitHubAPIURL,
  createGitHubJSONHeaders,
  getGitHubEnvironment,
  type GitHubEnvironment,
  rejectTokenlessRequestWhenLoginRequired,
} from '@/lib/githubEnvironment';
import {
  createGitHubFailureResponse,
  createUnreachableResponse,
} from '@/lib/githubProxyResponse';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseBearerToken } from '@/lib/parseBearerToken';
import type {
  GitHubDiffSide,
  PullDiscussionComment,
  PullReviewComment,
} from '@/lib/types';

// Proxies GitHub pull-request review comments for the configured instance:
//   GET    ?owner&repo&pull            → all review comments plus PR-level
//                                        discussion (issue comments and
//                                        review summaries), normalized
//   POST   {owner, repo, pull, body, inReplyToId}          → reply to a thread
//   POST   {owner, repo, pull, body, path, line, side, …}  → new comment
//   POST   {owner, repo, pull, body, discussion: true}     → new PR-level comment
//   POST   {owner, repo, pull, review: true, event, body, comments} → submit a
//          review: verdict (APPROVE / REQUEST_CHANGES / COMMENT), optional
//          summary body, and the batched inline comments, in one call
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

export async function GET(request: NextRequest) {
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

  const token = parseBearerToken(request.headers.get('authorization'));
  const environment = getGitHubEnvironment();

  // Review comments are the core payload — their failures fail the request.
  // The PR-level discussion (issue comments, review summaries) is best-effort
  // extra context: any failure there degrades to an empty list rather than
  // blocking the inline threads.
  const [reviewResult, issueResult, reviewsResult] = await Promise.all([
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
  ]);
  if (reviewResult === 'unreachable') {
    return createUnreachableResponse(environment);
  }
  if ('failure' in reviewResult) {
    return reviewResult.failure;
  }

  const comments: PullReviewComment[] = [];
  for (const record of reviewResult.records) {
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
    fetch(
      createGitHubAPIURL(environment, pathname, {
        page: String(page),
        per_page: String(PER_PAGE),
      }),
      { cache: 'no-store', headers: buildGitHubHeaders(token), signal }
    );

  const firstResponse = await fetchPage(1);
  if (!firstResponse.ok) {
    return { failure: await createGitHubFailureResponse(firstResponse) };
  }
  const records = [...((await firstResponse.json()) as unknown[])];
  const lastPage = Math.min(
    parseLastPage(firstResponse.headers.get('link')),
    MAX_COMMENT_PAGES
  );
  if (lastPage > 1) {
    const restResponses = await Promise.all(
      Array.from({ length: lastPage - 1 }, (_, index) => fetchPage(index + 2))
    );
    for (const response of restResponses) {
      if (!response.ok) {
        return { failure: await createGitHubFailureResponse(response) };
      }
      records.push(...((await response.json()) as unknown[]));
    }
  }
  return { records };
}

export async function POST(request: NextRequest) {
  const token = parseBearerToken(request.headers.get('authorization'));
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
        await fetch(
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
        await fetch(
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
        { error: 'path, line, and side are required for a new comment.' },
        { status: 400 }
      );
    }

    // New review comments must reference the diff revision they were written
    // against; resolve the pull's current head commit server-side.
    const commitId = await resolvePullHeadCommit(
      environment,
      token,
      owner,
      repo,
      pull
    );
    if (typeof commitId !== 'string') {
      return commitId;
    }

    return await forwardNormalizedResponse(
      await fetch(
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

export async function PATCH(request: NextRequest) {
  const token = parseBearerToken(request.headers.get('authorization'));
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
    const response = await fetch(
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

export async function DELETE(request: NextRequest) {
  const token = parseBearerToken(request.headers.get('authorization'));
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
    const response = await fetch(
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
    const commitId = await resolvePullHeadCommit(
      environment,
      token,
      owner,
      repo,
      pull
    );
    if (typeof commitId !== 'string') {
      return commitId;
    }
    const response = await fetch(
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
    // May be null for a bodiless COMMENTED review (dropped from the
    // discussion feed by design); the client refetches comments regardless.
    return createJSONResponse({
      review: normalizeReviewSummary(await response.json()),
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
  const path = record.path;
  const line = record.line;
  const side = record.side;
  if (
    typeof path !== 'string' ||
    path === '' ||
    typeof line !== 'number' ||
    !isGitHubDiffSide(side)
  ) {
    return null;
  }
  const anchor: Record<string, unknown> = { line, path, side };
  if (typeof record.startLine === 'number' && record.startLine !== line) {
    anchor.start_line = record.startLine;
    anchor.start_side = isGitHubDiffSide(record.startSide)
      ? record.startSide
      : side;
  }
  return anchor;
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
  const pullResponse = await fetch(
    createGitHubAPIURL(environment, `/repos/${owner}/${repo}/pulls/${pull}`),
    { cache: 'no-store', headers: buildGitHubHeaders(token) }
  );
  if (!pullResponse.ok) {
    return createGitHubFailureResponse(pullResponse);
  }
  const pullData = (await pullResponse.json()) as {
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
    path: record.path,
    side: isGitHubDiffSide(record.side) ? record.side : null,
    startLine: typeof record.start_line === 'number' ? record.start_line : null,
    startSide: isGitHubDiffSide(record.start_side) ? record.start_side : null,
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
  const comment = normalize(await response.json());
  if (comment == null) {
    return createJSONResponse(
      { error: 'GitHub returned an unexpected comment payload.' },
      { status: 502 }
    );
  }
  return createJSONResponse({ comment });
}

function buildGitHubHeaders(token: string | undefined): HeadersInit {
  return {
    ...createGitHubJSONHeaders(token),
    'Content-Type': 'application/json',
  };
}

// Extracts the last page number from GitHub's pagination Link header;
// a missing rel="last" means the response was the only (or final) page.
function parseLastPage(linkHeader: string | null): number {
  const match = linkHeader?.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  return match != null ? Number(match[1]) : 1;
}

async function parseJSONBody(
  request: NextRequest
): Promise<Record<string, unknown> | null> {
  try {
    const payload = (await request.json()) as unknown;
    return typeof payload === 'object' && payload != null
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isGitHubDiffSide(value: unknown): value is GitHubDiffSide {
  return value === 'LEFT' || value === 'RIGHT';
}

function isValidSegment(value: unknown): value is string {
  return typeof value === 'string' && /^[\w.-]+$/.test(value);
}

function isValidNumber(value: unknown): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}
