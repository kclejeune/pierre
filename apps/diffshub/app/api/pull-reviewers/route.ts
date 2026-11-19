import { type NextRequest } from 'next/server';

import {
  commitErrorResponse,
  repoPath,
  sendGitHubJSON,
} from '@/lib/githubCommitServer';
import { encodeURLSegment } from '@/lib/githubDiffSource';
import { rejectTokenlessRequestWhenLoginRequired } from '@/lib/githubEnvironment';
import {
  fetchReviewerCandidates,
  parsePullDetails,
  readPullReviewerChange,
} from '@/lib/githubPullDetailsServer';
import { readRepoParams } from '@/lib/githubRepoBrowserServer';
import {
  createJSONResponse,
  createPrivateJSONResponse,
} from '@/lib/jsonResponse';
import { parseJSONBody } from '@/lib/parseJSONBody';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';

// A pull's requested reviewers. GET lists the users the reviewer picker can
// offer for a repository (?owner=&repo=&q=); POST requests or removes one
// user's review on a pull and returns the pull's pending reviewers after the
// change, as the details panel lists them.

// GitHub's assignable-user search ignores anything past a short prefix in
// practice; capping it keeps a pasted paragraph from becoming a query.
const MAX_CANDIDATE_QUERY_LENGTH = 64;

async function handleGET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }
  const params = request.nextUrl.searchParams;
  const repo = readRepoParams(params);
  if (repo instanceof Response) {
    return repo;
  }
  const query = (params.get('q') ?? '').trim();
  if (query.length > MAX_CANDIDATE_QUERY_LENGTH) {
    return createJSONResponse(
      {
        error: `Reviewer search is limited to ${MAX_CANDIDATE_QUERY_LENGTH} characters.`,
      },
      { status: 400 }
    );
  }
  // GraphQL needs a token.
  const token = await resolveBearerToken(request);
  if (token == null) {
    return createJSONResponse(
      { error: 'Listing reviewers requires signing in or saving a token.' },
      { status: 401 }
    );
  }
  try {
    const candidates = await fetchReviewerCandidates(repo, query, token);
    return createPrivateJSONResponse({ candidates }, 60);
  } catch (error) {
    return commitErrorResponse(error);
  }
}

async function handlePOST(request: NextRequest) {
  const token = await resolveBearerToken(request);
  if (token == null) {
    return createJSONResponse(
      { error: 'Changing reviewers requires signing in or saving a token.' },
      { status: 401 }
    );
  }
  const change = readPullReviewerChange(await parseJSONBody(request));
  if (change == null) {
    return createJSONResponse(
      {
        error:
          'owner, repo, pull, action (add or remove), and a user login are required.',
      },
      { status: 400 }
    );
  }
  // Both methods answer with the pull, whose requested_reviewers and
  // requested_teams are the pending requests after the change.
  try {
    const payload = await sendGitHubJSON(
      repoPath(
        change,
        `/pulls/${encodeURLSegment(change.pull)}/requested_reviewers`
      ),
      token,
      change.action === 'add' ? 'POST' : 'DELETE',
      { reviewers: [change.login] }
    );
    return createJSONResponse({
      reviewers: parsePullDetails(payload).reviewers,
    });
  } catch (error) {
    return commitErrorResponse(error);
  }
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
