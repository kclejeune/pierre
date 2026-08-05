import { type NextRequest } from 'next/server';

import {
  createGitHubAPIURL,
  getGitHubEnvironment,
  GITHUB_API_VERSION,
  GITHUB_USER_AGENT,
  type GitHubEnvironment,
} from '@/lib/githubEnvironment';
import { parseBearerToken } from '@/lib/parseBearerToken';
import type { GitHubDiffSide, PullReviewComment } from '@/lib/types';

// Proxies GitHub pull-request review comments for the configured instance:
//   GET    ?owner&repo&pull            → all review comments, normalized
//   POST   {owner, repo, pull, body, inReplyToId}          → reply to a thread
//   POST   {owner, repo, pull, body, path, line, side, …}  → new comment
//   PATCH  {owner, repo, commentId, body}                  → edit a comment
//   DELETE ?owner&repo&commentId                           → delete a comment
//
// Reads may fall back to the server-side token (same as diff loading) so
// public-repo threads render for anonymous visitors. Writes always require
// the requester's own token — the server token must never author, edit, or
// delete comments on a visitor's behalf.

const MAX_COMMENT_PAGES = 10;
const PER_PAGE = 100;

export async function GET(request: NextRequest) {
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

  const token =
    parseBearerToken(request.headers.get('authorization')) ??
    getFallbackToken();
  const environment = getGitHubEnvironment();
  const comments: PullReviewComment[] = [];
  try {
    for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
      const response = await fetch(
        createGitHubAPIURL(
          environment,
          `/repos/${owner}/${repo}/pulls/${pull}/comments`,
          { page: String(page), per_page: String(PER_PAGE) }
        ),
        { cache: 'no-store', headers: buildGitHubHeaders(token) }
      );
      if (!response.ok) {
        return createGitHubFailureResponse(response);
      }

      const pageComments = (await response.json()) as unknown[];
      for (const comment of pageComments) {
        const normalized = normalizeReviewComment(comment);
        if (normalized != null) {
          comments.push(normalized);
        }
      }
      if (pageComments.length < PER_PAGE) {
        break;
      }
    }
  } catch {
    return createUnreachableResponse(environment);
  }

  return createJSONResponse({ comments });
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
  const body = payload?.body;
  if (
    !isValidSegment(owner) ||
    !isValidSegment(repo) ||
    !isValidNumber(pull) ||
    typeof body !== 'string' ||
    body.trim() === ''
  ) {
    return createJSONResponse(
      { error: 'owner, repo, pull, and a non-empty body are required.' },
      { status: 400 }
    );
  }

  const environment = getGitHubEnvironment();
  const inReplyToId = payload?.inReplyToId;
  try {
    if (typeof inReplyToId === 'number') {
      return await forwardCommentResponse(
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
        )
      );
    }

    const path = payload?.path;
    const line = payload?.line;
    const side = payload?.side;
    if (
      typeof path !== 'string' ||
      path === '' ||
      typeof line !== 'number' ||
      !isGitHubDiffSide(side)
    ) {
      return createJSONResponse(
        { error: 'path, line, and side are required for a new comment.' },
        { status: 400 }
      );
    }

    // New review comments must reference the diff revision they were written
    // against; resolve the pull's current head commit server-side.
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

    const startLine = payload?.startLine;
    const startSide = payload?.startSide;
    const commentBody: Record<string, unknown> = {
      body,
      commit_id: commitId,
      line,
      path,
      side,
    };
    // GitHub rejects start_line equal to line, so only send a start anchor
    // for genuinely multi-line comments.
    if (typeof startLine === 'number' && startLine !== line) {
      commentBody.start_line = startLine;
      commentBody.start_side = isGitHubDiffSide(startSide) ? startSide : side;
    }

    return await forwardCommentResponse(
      await fetch(
        createGitHubAPIURL(
          environment,
          `/repos/${owner}/${repo}/pulls/${pull}/comments`
        ),
        {
          method: 'POST',
          headers: buildGitHubHeaders(token),
          body: JSON.stringify(commentBody),
        }
      )
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
  try {
    return await forwardCommentResponse(
      await fetch(
        createGitHubAPIURL(
          environment,
          `/repos/${owner}/${repo}/pulls/comments/${commentId}`
        ),
        {
          method: 'PATCH',
          headers: buildGitHubHeaders(token),
          body: JSON.stringify({ body }),
        }
      )
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
  try {
    const response = await fetch(
      createGitHubAPIURL(
        environment,
        `/repos/${owner}/${repo}/pulls/comments/${commentId}`
      ),
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
    htmlUrl: typeof record.html_url === 'string' ? record.html_url : '',
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

// Relays a GitHub create/edit response back to the browser as a normalized
// comment, preserving failure details for actionable error messages.
async function forwardCommentResponse(response: Response): Promise<Response> {
  if (!response.ok) {
    return createGitHubFailureResponse(response);
  }
  const comment = normalizeReviewComment(await response.json());
  if (comment == null) {
    return createJSONResponse(
      { error: 'GitHub returned an unexpected comment payload.' },
      { status: 502 }
    );
  }
  return createJSONResponse({ comment });
}

async function createGitHubFailureResponse(
  response: Response
): Promise<Response> {
  let detail = '';
  try {
    const payload = (await response.json()) as { message?: unknown };
    if (typeof payload.message === 'string') {
      detail = payload.message;
    }
  } catch {
    // Non-JSON failure body; the status alone still tells the story.
  }
  return createJSONResponse(
    {
      error:
        detail === ''
          ? `GitHub responded with ${response.status}.`
          : `GitHub responded with ${response.status}: ${detail}`,
    },
    // 401/403/404/422 are actionable for the caller; everything else is a
    // gateway-style failure.
    { status: response.status >= 500 ? 502 : response.status }
  );
}

function createUnreachableResponse(environment: GitHubEnvironment): Response {
  return createJSONResponse(
    { error: `Could not reach ${environment.host}.` },
    { status: 502 }
  );
}

function buildGitHubHeaders(token: string | undefined): HeadersInit {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': GITHUB_USER_AGENT,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
  if (token != null) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function getFallbackToken(): string | undefined {
  return (
    process.env.DIFFSHUB_GITHUB_TOKEN ??
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN
  );
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

function createJSONResponse(
  body: unknown,
  options: { status?: number } = {}
): Response {
  return Response.json(body, {
    status: options.status ?? 200,
    headers: {
      'Cache-Control': 'no-store',
      Vary: 'Authorization',
    },
  });
}
