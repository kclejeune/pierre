'use client';

import { useEffect, useState } from 'react';

import { useGitHubToken } from './useGitHubToken';

export interface GitHubUser {
  avatarUrl: string;
  login: string;
  name: string | null;
}

// Resolved identities keyed by token so every consumer (draft forms, comment
// lists) shares one /api/github-user request per token instead of refetching
// on each mount. Failed lookups cache as null so a bad token does not retrigger
// a request storm; changing the token naturally retries under the new key.
const userCacheByToken = new Map<string, Promise<GitHubUser | null>>();

function fetchGitHubUser(token: string): Promise<GitHubUser | null> {
  let pending = userCacheByToken.get(token);
  if (pending == null) {
    pending = fetch('/api/github-user', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((user: GitHubUser | null) => user)
      .catch(() => null);
    userCacheByToken.set(token, pending);
  }
  return pending;
}

// Resolves the GitHub identity (login, avatar) behind the saved token, if any.
// Returns null while unresolved, when no token is saved, or when the token
// cannot access /user (e.g. a fine-grained PAT without account read access).
export function useGitHubUser(): GitHubUser | null {
  const { token } = useGitHubToken();
  const [user, setUser] = useState<GitHubUser | null>(null);

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
