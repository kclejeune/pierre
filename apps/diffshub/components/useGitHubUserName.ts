'use client';

import { useEffect, useState } from 'react';

import { readStoredGitHubToken } from './useGitHubToken';

// Display names keyed by login so every avatar fallback shares one
// /api/github-user?login= request per author instead of refetching on each
// mount. Failed lookups cache as null so a missing profile does not
// retrigger a request storm; resolved values are kept separately so
// late-mounting consumers render synchronously.
const pendingNameByLogin = new Map<string, Promise<string | null>>();
const resolvedNameByLogin = new Map<string, string | null>();

function fetchUserName(login: string): Promise<string | null> {
  let pending = pendingNameByLogin.get(login);
  if (pending == null) {
    const token = readStoredGitHubToken();
    pending = fetch(`/api/github-user?login=${encodeURIComponent(login)}`, {
      headers: token === '' ? {} : { Authorization: `Bearer ${token}` },
    })
      .then(async (response) => {
        if (!response.ok) {
          return null;
        }
        const user = (await response.json()) as { name?: unknown };
        return typeof user.name === 'string' && user.name !== ''
          ? user.name
          : null;
      })
      .catch(() => null);
    void pending.then((name) => resolvedNameByLogin.set(login, name));
    pendingNameByLogin.set(login, pending);
  }
  return pending;
}

// Resolves a user's profile display name for avatar initials. Pass null to
// skip the lookup (the hook only fetches when the fallback actually shows).
// Returns null while unresolved or when the profile has no name set.
export function useGitHubUserName(login: string | null): string | null {
  const [name, setName] = useState<string | null>(() =>
    login == null ? null : (resolvedNameByLogin.get(login) ?? null)
  );

  useEffect(() => {
    if (login == null) {
      return;
    }
    let cancelled = false;
    void fetchUserName(login).then((resolvedName) => {
      if (!cancelled) {
        setName(resolvedName);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [login]);

  return login == null ? null : name;
}
