'use client';

import { storedGitHubTokenHeaders } from './githubSession';
import { useGitHubToken } from './useGitHubToken';
import { createCachedLookup } from '@/lib/cachedLookup';
import type { CommentAuthor } from '@/lib/types';

// Key by the non-secret credential version rather than retaining a raw token
// in module state. The browser cache handles response reuse across page loads.
const gitHubUserByVersion = createCachedLookup(
  (_version: number) =>
    fetch('/api/github-user', {
      headers: storedGitHubTokenHeaders(),
    }).then((response) =>
      response.ok ? (response.json() as Promise<CommentAuthor>) : null
    ),
  { maxEntries: 8, valueTTL: 60_000 }
);

// Resolves the GitHub identity (login, avatar) behind the saved token, if any.
// Returns null while unresolved, when no token is saved, or when the token
// cannot access /user (e.g. a fine-grained PAT without account read access).
export function useGitHubUser(): CommentAuthor | null {
  const { hasToken, tokenVersion } = useGitHubToken();
  return gitHubUserByVersion.useValue(hasToken ? tokenVersion : null);
}
