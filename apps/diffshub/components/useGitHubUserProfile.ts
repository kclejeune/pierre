'use client';

import { githubFetch } from './githubSession';
import { useGitHubTokenSnapshot } from './useGitHubToken';
import { createTokenScopedLookup } from '@/lib/cachedLookup';

// A user's profile as served by /api/github-user?login=: the display name
// behind avatar initials, plus a freshly issued avatar URL. The avatar URLs
// embedded in comment payloads can be short-lived signed URLs (GHES,
// enterprise managed users), so a fresh profile fetch is the reliable
// fallback when the embedded URL fails to load.
export interface GitHubUserProfile {
  avatarUrl: string;
  name: string | null;
}

// Profiles are scoped to the token generation so an auth failure or account
// switch cannot pin a lookup from the previous identity.
const profileByLogin = createTokenScopedLookup(async (login: string) => {
  const response = await githubFetch(
    `/api/github-user?login=${encodeURIComponent(login)}`
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
  const { version: tokenVersion } = useGitHubTokenSnapshot();
  return profileByLogin.useValue(tokenVersion, login);
}
