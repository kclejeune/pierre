import { type NextRequest } from 'next/server';

import {
  commitErrorResponse,
  fetchPullData,
  parsePullRefs,
} from '@/lib/githubCommitServer';
import { rejectTokenlessRequestWhenLoginRequired } from '@/lib/githubEnvironment';
import {
  fetchPullChecks,
  fetchPullReviewStates,
  mergeReviewerStates,
  parsePullDetails,
} from '@/lib/githubPullDetailsServer';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseBearerToken } from '@/lib/parseBearerToken';
import type { PullInfo } from '@/lib/pullInfoClient';

// The pull request's refs plus the metadata the details panel shows: title,
// description, labels, reviewers with their latest verdicts, draft/merge
// state, and the CI signals on the head commit. The patch stream carries
// none of this. Read-only; on github.com anonymous visitors still get
// public-repo pulls labelled without a login. The reviews and checks
// listings are best-effort — a failure there degrades the panel, not the
// response.
export async function GET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }

  const params = request.nextUrl.searchParams;
  const owner = params.get('owner');
  const repo = params.get('repo');
  const pull = params.get('pull');
  if (owner == null || repo == null || pull == null || !/^\d+$/.test(pull)) {
    return createJSONResponse(
      { error: 'owner, repo, and pull are required.' },
      { status: 400 }
    );
  }

  const token = parseBearerToken(request.headers.get('authorization'));
  try {
    const data = await fetchPullData({ owner, repo }, pull, token);
    const refs = parsePullRefs(data, { owner, repo });
    const details = parsePullDetails(data);
    const [reviewStates, checks] = await Promise.all([
      fetchPullReviewStates({ owner, repo }, pull, token).catch(() => null),
      fetchPullChecks({ owner, repo }, refs.headSha, token).catch(() => null),
    ]);
    const payload: PullInfo = {
      ...refs,
      details: {
        ...details,
        checks,
        reviewers:
          reviewStates == null
            ? details.reviewers
            : mergeReviewerStates(details.reviewers, reviewStates),
      },
      number: pull,
    };
    return createJSONResponse(payload);
  } catch (error) {
    return commitErrorResponse(error);
  }
}
