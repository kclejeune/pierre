import { type NextRequest } from 'next/server';

import {
  commitErrorResponse,
  GitHubCommitError,
  repoPath,
  sendGitHubJSON,
} from '@/lib/githubCommitServer';
import { encodeURLSegment } from '@/lib/githubDiffSource';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseJSONBody } from '@/lib/parseJSONBody';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';
import { asRecord } from '@/lib/untypedJson';

const MERGE_METHODS = new Set(['merge', 'rebase', 'squash']);

// Merges the pull request into its base branch on the viewer's behalf —
// GitHub's "Merge pull request" button. Always authenticated: the merge is
// attributed to the token's user, and GitHub enforces branch protections and
// permissions server-side. `expectedHeadSha` makes the merge
// compare-and-swap: GitHub answers 409 when the branch moved since the
// viewer looked at the diff, which commitErrorResponse forwards.
async function handlePOST(request: NextRequest) {
  const token = await resolveBearerToken(request);
  if (token == null) {
    return createJSONResponse(
      { error: 'Merging requires signing in or saving a token.' },
      { status: 401 }
    );
  }
  const body = await parseJSONBody(request);
  const owner = body?.owner;
  const repo = body?.repo;
  const pull = body?.pull;
  const method = body?.method;
  const expectedHeadSha = body?.expectedHeadSha;
  if (
    typeof owner !== 'string' ||
    typeof repo !== 'string' ||
    typeof pull !== 'string' ||
    !/^\d+$/.test(pull) ||
    typeof method !== 'string' ||
    !MERGE_METHODS.has(method) ||
    (expectedHeadSha != null && typeof expectedHeadSha !== 'string')
  ) {
    return createJSONResponse(
      { error: 'owner, repo, pull, and a valid merge method are required.' },
      { status: 400 }
    );
  }

  try {
    const payload = await sendGitHubJSON(
      repoPath({ owner, repo }, `/pulls/${encodeURLSegment(pull)}/merge`),
      token,
      'PUT',
      {
        merge_method: method,
        ...(expectedHeadSha == null ? {} : { sha: expectedHeadSha }),
      }
    );
    const record = asRecord(payload);
    return createJSONResponse({
      message: typeof record?.message === 'string' ? record.message : undefined,
      merged: record?.merged === true,
      sha: typeof record?.sha === 'string' ? record.sha : undefined,
    });
  } catch (error) {
    // A 409 from PUT /pulls/{n}/merge means the sha compare-and-swap failed
    // (the head moved since the viewer loaded the diff). Recode it here
    // rather than in the shared classifier, where other GitHub endpoints use
    // 409 for unrelated conditions (empty repository, ref-lock contention).
    if (error instanceof GitHubCommitError && error.status === 409) {
      return commitErrorResponse(
        new GitHubCommitError(error.message, 'stale-head', error.status)
      );
    }
    return commitErrorResponse(error);
  }
}

export const POST = withRequestLog(handlePOST);
