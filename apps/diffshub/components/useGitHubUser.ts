'use client';

import { useEffect, useState } from 'react';

import { useGitHubToken } from './useGitHubToken';
import type { CommentAuthor } from '@/lib/types';

// Identities keyed by token so every consumer (draft forms, comment lists)
// shares one /api/github-user request per token instead of refetching on each
// mount. Failed lookups cache as null so a bad token does not retrigger a
// request storm; changing the token naturally retries under the new key.
// Resolved values are kept separately so late-mounting consumers (e.g. thread
// cards scrolled into view) can render the identity synchronously.
const pendingUserByToken = new Map<string, Promise<CommentAuthor | null>>();
const resolvedUserByToken = new Map<string, CommentAuthor | null>();

function fetchGitHubUser(token: string): Promise<CommentAuthor | null> {
  let pending = pendingUserByToken.get(token);
  if (pending == null) {
    pending = fetch('/api/github-user', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((response) =>
        response.ok ? (response.json() as Promise<CommentAuthor>) : null
      )
      .catch(() => null);
    void pending.then((user) => resolvedUserByToken.set(token, user));
    pendingUserByToken.set(token, pending);
  }
  return pending;
}

// Resolves the GitHub identity (login, avatar) behind the saved token, if any.
// Returns null while unresolved, when no token is saved, or when the token
// cannot access /user (e.g. a fine-grained PAT without account read access).
export function useGitHubUser(): CommentAuthor | null {
  const { token } = useGitHubToken();
  const [user, setUser] = useState<CommentAuthor | null>(
    () => (token === '' ? null : resolvedUserByToken.get(token)) ?? null
  );

  useEffect(() => {
    if (token === '') {
      setUser(null);
      return;
    }

    let cancelled = false;
    void fetchGitHubUser(token).then((resolvedUser) => {
      if (!cancelled) {
        setUser(resolvedUser);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return user;
}
