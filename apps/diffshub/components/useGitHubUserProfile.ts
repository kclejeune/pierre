'use client';

import { storedGitHubTokenHeaders } from './githubSession';
import { createCachedLookup } from '@/lib/cachedLookup';

// A user's profile as served by /api/github-user?login=: the display name
// behind avatar initials, plus a freshly issued avatar URL. The avatar URLs
// embedded in comment payloads can be short-lived signed URLs (GHES,
// enterprise managed users), so a fresh profile fetch is the reliable
// fallback when the embedded URL fails to load.
export interface GitHubUserProfile {
  avatarUrl: string;
  name: string | null;
}

// Profiles keyed by login so every avatar fallback shares one
// /api/github-user?login= request per author instead of refetching on each
// mount. Failed lookups cache as null so a missing profile does not
// retrigger a request storm.
const profileByLogin = createCachedLookup(async (login: string) => {
  const response = await fetch(
    `/api/github-user?login=${encodeURIComponent(login)}`,
    { headers: storedGitHubTokenHeaders() }
  );
  if (!response.ok) {
    return null;
  }
  const user = (await response.json()) as {
    avatarUrl?: unknown;
    name?: unknown;
  };
  return {
    avatarUrl: typeof user.avatarUrl === 'string' ? user.avatarUrl : '',
    name: typeof user.name === 'string' && user.name !== '' ? user.name : null,
  };
});

// Resolves a user's profile for the avatar fallback path. Pass null to skip
// the lookup (callers only fetch once the payload-embedded avatar URL is
// unusable). Returns null while unresolved or when the lookup fails.
export function useGitHubUserProfile(
  login: string | null
): GitHubUserProfile | null {
  return profileByLogin.useValue(login);
}
