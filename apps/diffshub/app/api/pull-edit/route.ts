import { type NextRequest } from 'next/server';

import {
  commitErrorResponse,
  fetchPullData,
  readStringPath,
  repoPath,
  sendGitHubGraphQL,
  sendGitHubJSON,
} from '@/lib/githubCommitServer';
import { encodeURLSegment } from '@/lib/githubDiffSource';
import {
  parsePullDetails,
  readPullEditRequest,
} from '@/lib/githubPullDetailsServer';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseJSONBody } from '@/lib/parseJSONBody';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';
import { asRecord } from '@/lib/untypedJson';

const SET_DRAFT_MUTATIONS = {
  draft: `mutation ($id: ID!) {
    convertPullRequestToDraft(input: { pullRequestId: $id }) {
      pullRequest { isDraft }
    }
  }`,
  ready: `mutation ($id: ID!) {
    markPullRequestReadyForReview(input: { pullRequestId: $id }) {
      pullRequest { isDraft }
    }
  }`,
};

// PATCHes title/body/state; draft goes through GraphQL since REST has no
// toggle. Returns the refreshed details.
async function handlePOST(request: NextRequest) {
  const token = await resolveBearerToken(request);
  if (token == null) {
    return createJSONResponse(
      { error: 'Editing requires signing in or saving a token.' },
      { status: 401 }
    );
  }
  const edit = readPullEditRequest(await parseJSONBody(request));
  if (edit == null) {
    return createJSONResponse(
      {
        error:
          'owner, repo, pull, and a title, body, state, or draft change are required.',
      },
      { status: 400 }
    );
  }

  const { draft, owner, pull, repo, ...changes } = edit;
  try {
    let payload: unknown;
    if (Object.keys(changes).length > 0) {
      payload = await sendGitHubJSON(
        repoPath({ owner, repo }, `/pulls/${encodeURLSegment(pull)}`),
        token,
        'PATCH',
        changes
      );
    }
    if (draft != null) {
      payload ??= await fetchPullData({ owner, repo }, pull, token);
      const data = asRecord(
        await sendGitHubGraphQL(
          SET_DRAFT_MUTATIONS[draft ? 'draft' : 'ready'],
          { id: readStringPath(payload, ['node_id']) },
          token
        )
      );
      const result = asRecord(
        data?.convertPullRequestToDraft ?? data?.markPullRequestReadyForReview
      );
      // Patch the REST payload with the mutation's result instead of
      // re-reading the pull.
      payload = {
        ...asRecord(payload),
        draft: asRecord(result?.pullRequest)?.isDraft === true,
      };
    }
    return createJSONResponse(parsePullDetails(payload));
  } catch (error) {
    return commitErrorResponse(error);
  }
}

export const POST = withRequestLog(handlePOST);
