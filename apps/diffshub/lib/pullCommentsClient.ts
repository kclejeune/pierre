import type { SelectedLineRange } from '@pierre/diffs';

import { toGitHubDiffSide } from './pullReviewThreads';
import type {
  GitHubDiffSide,
  PullDiscussionComment,
  PullReviewComment,
} from './types';

// Identifies the pull request a viewer route displays, for review-comment
// API calls.
export interface PullRequestRef {
  number: string;
  owner: string;
  repo: string;
}

interface NewCommentAnchor {
  line: number;
  path: string;
  side: GitHubDiffSide;
  startLine?: number;
  startSide?: GitHubDiffSide;
}

export interface PullCommentsPayload {
  comments: PullReviewComment[];
  // PR-level conversation: issue comments and review summaries, in creation
  // order. Empty when the server's best-effort discussion fetch failed.
  discussion: PullDiscussionComment[];
}

// Browser-side wrappers over /api/pull-comments. All failures throw an Error
// whose message is already user-presentable (the route forwards GitHub's
// explanation).
export async function fetchPullComments(
  pull: PullRequestRef,
  token: string | undefined,
  signal?: AbortSignal
): Promise<PullCommentsPayload> {
  const params = new URLSearchParams({
    owner: pull.owner,
    pull: pull.number,
    repo: pull.repo,
  });
  const payload = await requestJSON(`/api/pull-comments?${params}`, {
    headers: buildHeaders(token),
    signal,
  });
  const comments = (payload as { comments?: unknown }).comments;
  const discussion = (payload as { discussion?: unknown }).discussion;
  return {
    comments: Array.isArray(comments) ? (comments as PullReviewComment[]) : [],
    discussion: Array.isArray(discussion)
      ? (discussion as PullDiscussionComment[])
      : [],
  };
}

export async function postPullReviewReply(
  pull: PullRequestRef,
  token: string,
  inReplyToId: number,
  body: string
): Promise<PullReviewComment> {
  return await requestComment('/api/pull-comments', {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify({
      body,
      inReplyToId,
      owner: pull.owner,
      pull: pull.number,
      repo: pull.repo,
    }),
  });
}

export async function postPullReviewComment(
  pull: PullRequestRef,
  token: string,
  anchor: NewCommentAnchor,
  body: string
): Promise<PullReviewComment> {
  return await requestComment('/api/pull-comments', {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify({
      body,
      line: anchor.line,
      owner: pull.owner,
      path: anchor.path,
      pull: pull.number,
      repo: pull.repo,
      side: anchor.side,
      startLine: anchor.startLine,
      startSide: anchor.startSide,
    }),
  });
}

export async function editPullReviewComment(
  pull: PullRequestRef,
  token: string,
  commentId: number,
  body: string
): Promise<PullReviewComment> {
  return await requestComment('/api/pull-comments', {
    method: 'PATCH',
    headers: buildHeaders(token),
    body: JSON.stringify({
      body,
      commentId,
      owner: pull.owner,
      repo: pull.repo,
    }),
  });
}

export async function deletePullReviewComment(
  pull: PullRequestRef,
  token: string,
  commentId: number
): Promise<void> {
  const params = new URLSearchParams({
    commentId: String(commentId),
    owner: pull.owner,
    repo: pull.repo,
  });
  await requestJSON(`/api/pull-comments?${params}`, {
    method: 'DELETE',
    headers: buildHeaders(token),
  });
}

// PR-level conversation writes: GitHub issue comments on the pull request,
// with no diff anchor. Review summaries cannot be written through these.
export async function postPullDiscussionComment(
  pull: PullRequestRef,
  token: string,
  body: string
): Promise<PullDiscussionComment> {
  return await requestDiscussionComment('/api/pull-comments', {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify({
      body,
      discussion: true,
      owner: pull.owner,
      pull: pull.number,
      repo: pull.repo,
    }),
  });
}

export async function editPullDiscussionComment(
  pull: PullRequestRef,
  token: string,
  commentId: number,
  body: string
): Promise<PullDiscussionComment> {
  return await requestDiscussionComment('/api/pull-comments', {
    method: 'PATCH',
    headers: buildHeaders(token),
    body: JSON.stringify({
      body,
      commentId,
      discussion: true,
      owner: pull.owner,
      repo: pull.repo,
    }),
  });
}

export async function deletePullDiscussionComment(
  pull: PullRequestRef,
  token: string,
  commentId: number
): Promise<void> {
  const params = new URLSearchParams({
    commentId: String(commentId),
    discussion: 'true',
    owner: pull.owner,
    repo: pull.repo,
  });
  await requestJSON(`/api/pull-comments?${params}`, {
    method: 'DELETE',
    headers: buildHeaders(token),
  });
}

// Maps a draft annotation's selected range to the GitHub anchor fields for a
// new review comment. GitHub rejects start_line === line, so single-line
// ranges omit the start anchor.
export function createCommentAnchor(
  path: string,
  range: SelectedLineRange
): NewCommentAnchor | null {
  const endSide = range.endSide ?? range.side;
  if (endSide == null) {
    return null;
  }
  const anchor: NewCommentAnchor = {
    line: range.end,
    path,
    side: toGitHubDiffSide(endSide),
  };
  if (range.start !== range.end) {
    anchor.startLine = range.start;
    anchor.startSide = toGitHubDiffSide(range.side ?? endSide);
  }
  return anchor;
}

async function requestComment(
  input: string,
  init: RequestInit
): Promise<PullReviewComment> {
  const payload = await requestJSON(input, init);
  const comment = (payload as { comment?: unknown }).comment;
  if (typeof comment !== 'object' || comment == null) {
    throw new Error('GitHub returned an unexpected comment payload.');
  }
  return comment as PullReviewComment;
}

async function requestDiscussionComment(
  input: string,
  init: RequestInit
): Promise<PullDiscussionComment> {
  const payload = await requestJSON(input, init);
  const comment = (payload as { comment?: unknown }).comment;
  if (typeof comment !== 'object' || comment == null) {
    throw new Error('GitHub returned an unexpected comment payload.');
  }
  return comment as PullDiscussionComment;
}

async function requestJSON(input: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(input, { cache: 'no-store', ...init });
  } catch {
    throw new Error('Could not reach the DiffsHub server.');
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Some failures have no JSON body; fall through to the status check.
  }
  if (!response.ok) {
    const error = (payload as { error?: unknown } | null)?.error;
    throw new Error(
      typeof error === 'string' && error !== ''
        ? error
        : `Request failed (${response.status}).`
    );
  }
  return payload;
}

function buildHeaders(token: string | undefined): HeadersInit | undefined {
  return token == null || token === ''
    ? undefined
    : { Authorization: `Bearer ${token}` };
}
