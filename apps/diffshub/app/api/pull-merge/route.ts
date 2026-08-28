import { type NextRequest } from 'next/server';

import {
  commitErrorResponse,
  repoPath,
  sendGitHubJSON,
} from '@/lib/githubCommitServer';
import { encodeURLSegment } from '@/lib/githubDiffSource';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseBearerToken } from '@/lib/parseBearerToken';
import { parseJSONBody } from '@/lib/parseJSONBody';
import { asRecord } from '@/lib/untypedJson';

const MERGE_METHODS = new Set(['merge', 'rebase', 'squash']);

// Merges the pull request into its base branch on the viewer's behalf —
// GitHub's "Merge pull request" button. Always authenticated: the merge is
// attributed to the token's user, and GitHub enforces branch protections and
// permissions server-side. `expectedHeadSha` makes the merge
// compare-and-swap: GitHub answers 409 when the branch moved since the
// viewer looked at the diff, which commitErrorResponse forwards.
export async function POST(request: NextRequest) {
  const token = parseBearerToken(request.headers.get('authorization'));
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
      merged: record?.merged === true,
      sha: typeof record?.sha === 'string' ? record.sha : undefined,
    });
  } catch (error) {
    return commitErrorResponse(error);
  }
}
