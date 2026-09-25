import { type NextRequest } from 'next/server';

import {
  commitErrorResponse,
  repoPath,
  sendGitHubJSON,
} from '@/lib/githubCommitServer';
import { encodeURLSegment } from '@/lib/githubDiffSource';
import { rejectTokenlessRequestWhenLoginRequired } from '@/lib/githubEnvironment';
import {
  fetchRepoLabels,
  parseLabels,
  readPullLabelChange,
} from '@/lib/githubPullDetailsServer';
import { readRepoParams } from '@/lib/githubRepoBrowserServer';
import {
  createJSONResponse,
  createPrivateJSONResponse,
} from '@/lib/jsonResponse';
import { parseJSONBody } from '@/lib/parseJSONBody';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';

async function handleGET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }
  const repo = readRepoParams(request.nextUrl.searchParams);
  if (repo instanceof Response) {
    return repo;
  }
  try {
    const labels = await fetchRepoLabels(
      repo,
      await resolveBearerToken(request)
    );
    return createPrivateJSONResponse({ labels }, 60);
  } catch (error) {
    return commitErrorResponse(error);
  }
}

// Labels live on the pull's issue; both endpoints return the full label list
// after the change.
async function handlePOST(request: NextRequest) {
  const token = await resolveBearerToken(request);
  if (token == null) {
    return createJSONResponse(
      { error: 'Changing labels requires signing in or saving a token.' },
      { status: 401 }
    );
  }
  const change = readPullLabelChange(await parseJSONBody(request));
  if (change == null) {
    return createJSONResponse(
      { error: 'owner, repo, pull, action, and label are required.' },
      { status: 400 }
    );
  }
  const labelsPath = repoPath(
    change,
    `/issues/${encodeURLSegment(change.pull)}/labels`
  );
  try {
    const payload =
      change.action === 'add'
        ? await sendGitHubJSON(labelsPath, token, 'POST', {
            labels: [change.label],
          })
        : await sendGitHubJSON(
            `${labelsPath}/${encodeURLSegment(change.label)}`,
            token,
            'DELETE',
            undefined
          );
    return createJSONResponse({ labels: parseLabels(payload) });
  } catch (error) {
    return commitErrorResponse(error);
  }
}

export const GET = withRequestLog(handleGET);
export const POST = withRequestLog(handlePOST);
