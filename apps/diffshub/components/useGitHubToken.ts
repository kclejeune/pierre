'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import {
  getGitHubTokenSnapshot,
  getServerGitHubTokenSnapshot,
  isStoredGitHubTokenExpired,
  readStoredGitHubToken,
  refreshGitHubSessionIfNeeded,
  saveGitHubTokenToStorage,
  subscribeToGitHubToken,
} from './githubSession';
import { syncTokenPresenceCookie } from '@/lib/tokenPresenceCookie';

export interface GitHubTokenState {
  clearToken(): void;
  hasToken: boolean;
  // False until the stored token has been read (and, for an expired GitHub
  // App token, refreshed) after mount. Fetch effects keyed on `token` should
  // skip while false, otherwise they fire once anonymously and immediately
  // refire when the stored token lands.
  hydrated: boolean;
  setToken(token: string): void;
  token: string;
  tokenVersion: number;
}

// React view of the stored GitHub token (see githubSession.ts). The token is
// persisted only in localStorage for this browser and is not sent anywhere
// until the loader explicitly reads it. useSyncExternalStore renders the
// server snapshot (no token) during hydration — server HTML is always
// rendered without a token, so seeding it earlier would mismatch — and every
// mounted consumer follows the slot from then on: a token refreshed by
// GitHubSessionRefresher, cleared in another tab, or pasted elsewhere on the
// page reaches all of them without each keeping its own copy.
export function useGitHubToken(): GitHubTokenState {
  const { token, version } = useSyncExternalStore(
    subscribeToGitHubToken,
    getGitHubTokenSnapshot,
    getServerGitHubTokenSnapshot
  );
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Always kick off a refresh check (cheap when nothing is expiring), but
    // only hold hydration for it when the stored token is already dead — so
    // the first wave of fetches keyed on `token` rides the new one instead of
    // failing once, without delaying consumers for a still-valid token.
    const refresh = refreshGitHubSessionIfNeeded();
    void (isStoredGitHubTokenExpired() ? refresh : Promise.resolve()).then(
      () => {
        if (cancelled) {
          return;
        }
        // Heal the middleware presence cookie for sessions whose token
        // predates it (or whose cookie expired while the stored token lives on).
        syncTokenPresenceCookie(readStoredGitHubToken() !== '');
        setHydrated(true);
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const setToken = useCallback((nextToken: string) => {
    saveGitHubTokenToStorage(nextToken);
  }, []);

  const clearToken = useCallback(() => {
    saveGitHubTokenToStorage('');
  }, []);

  return {
    clearToken,
    hasToken: token !== '',
    hydrated,
    setToken,
    token,
    tokenVersion: version,
  };
}
