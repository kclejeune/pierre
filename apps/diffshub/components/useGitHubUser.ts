'use client';

import { useGitHubToken } from './useGitHubToken';
import { createCachedLookup } from '@/lib/cachedLookup';
import type { CommentAuthor } from '@/lib/types';

// Identities keyed by token so every consumer (draft forms, comment lists)
// shares one /api/github-user request per token instead of refetching on each
// mount. Failed lookups cache as null so a bad token does not retrigger a
// request storm; changing the token naturally retries under the new key.
const gitHubUserByToken = createCachedLookup((token: string) =>
  fetch('/api/github-user', {
    headers: { Authorization: `Bearer ${token}` },
  }).then((response) =>
    response.ok ? (response.json() as Promise<CommentAuthor>) : null
  )
);

// Resolves the GitHub identity (login, avatar) behind the saved token, if any.
// Returns null while unresolved, when no token is saved, or when the token
// cannot access /user (e.g. a fine-grained PAT without account read access).
export function useGitHubUser(): CommentAuthor | null {
  const { token } = useGitHubToken();
  return gitHubUserByToken.useValue(token === '' ? null : token);
}
