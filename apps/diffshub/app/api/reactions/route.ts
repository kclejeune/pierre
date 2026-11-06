import { type NextRequest } from 'next/server';

import {
  commitErrorResponse,
  sendGitHubGraphQL,
} from '@/lib/githubCommitServer';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseJSONBody } from '@/lib/parseJSONBody';
import { getReactionDefinition, isReactionContent } from '@/lib/reactions';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';

// Adds or removes the requester's emoji reaction on a GitHub comment:
//   POST {subjectId, content, add} → { ok: true }
// subjectId is the comment's GraphQL node id (review comments, issue
// comments, and reviews all take reactions); content is a REST reaction name
// ('+1', 'heart', …). GraphQL toggles by subject and content, so no reaction
// id has to be tracked. Requires the requester's own token.

// addReaction and removeReaction take the same input.
function reactionMutation(add: boolean): string {
  return `mutation ($id: ID!, $content: ReactionContent!) {
    ${add ? 'addReaction' : 'removeReaction'}(input: { subjectId: $id, content: $content }) {
      clientMutationId
    }
  }`;
}

async function handlePOST(request: NextRequest) {
  const token = await resolveBearerToken(request);
  if (token == null) {
    return createJSONResponse(
      { error: 'Reacting requires signing in or saving a token.' },
      { status: 401 }
    );
  }
  const payload = await parseJSONBody(request);
  const subjectId = payload?.subjectId;
  const content = payload?.content;
  if (
    typeof subjectId !== 'string' ||
    subjectId === '' ||
    !isReactionContent(content) ||
    typeof payload?.add !== 'boolean'
  ) {
    return createJSONResponse(
      { error: 'subjectId, content, and add are required.' },
      { status: 400 }
    );
  }
  try {
    await sendGitHubGraphQL(
      reactionMutation(payload.add),
      { content: getReactionDefinition(content).graphql, id: subjectId },
      token
    );
    return createJSONResponse({ ok: true });
  } catch (error) {
    return commitErrorResponse(error);
  }
}

export const POST = withRequestLog(handlePOST);
