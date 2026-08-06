'use client';

import { storedGitHubTokenHeaders } from './useGitHubToken';
import { createCachedLookup } from '@/lib/cachedLookup';

// Display names keyed by login so every avatar fallback shares one
// /api/github-user?login= request per author instead of refetching on each
// mount. Failed lookups cache as null so a missing profile does not
// retrigger a request storm.
const userNameByLogin = createCachedLookup(async (login: string) => {
  const response = await fetch(
    `/api/github-user?login=${encodeURIComponent(login)}`,
    { headers: storedGitHubTokenHeaders() }
  );
  if (!response.ok) {
    return null;
  }
  const user = (await response.json()) as { name?: unknown };
  return typeof user.name === 'string' && user.name !== '' ? user.name : null;
});

// Resolves a user's profile display name for avatar initials. Pass null to
// skip the lookup (the hook only fetches when the fallback actually shows).
// Returns null while unresolved or when the profile has no name set.
export function useGitHubUserName(login: string | null): string | null {
  return userNameByLogin.useValue(login);
}
