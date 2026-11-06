'use client';

import { readStoredGitHubToken } from './githubSession';
import { buildHeaders, requestJSON } from '@/lib/pullCommentsClient';
import type { ReactionContent } from '@/lib/reactions';

// Browser-side wrapper over /api/reactions: adds (`add`) or removes the
// viewer's `content` reaction on the comment or review whose GraphQL node id
// is `subjectId`. Failures throw user-presentable Errors.
export async function saveViewerReaction(
  subjectId: string,
  content: ReactionContent,
  add: boolean
): Promise<void> {
  await requestJSON('/api/reactions', {
    method: 'POST',
    headers: {
      ...buildHeaders(readStoredGitHubToken()),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ add, content, subjectId }),
  });
}
