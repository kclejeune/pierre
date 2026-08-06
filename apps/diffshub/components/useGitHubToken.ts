'use client';

import { useCallback, useEffect, useState } from 'react';

import { syncTokenPresenceCookie } from '@/lib/tokenPresenceCookie';

const GITHUB_TOKEN_STORAGE_KEY = 'diffshub.github.token';

export interface GitHubTokenState {
  clearToken(): void;
  hasToken: boolean;
  // False until the stored token has been read from localStorage after mount.
  // Fetch effects keyed on `token` should skip while false, otherwise they
  // fire once anonymously and immediately refire when the stored token lands.
  hydrated: boolean;
  setToken(token: string): void;
  token: string;
  tokenVersion: number;
}

// Owns the optional user-provided GitHub token. The token is persisted only in
// localStorage for this browser and is not sent anywhere until the loader
// explicitly reads it. The stored token is deliberately read in a post-mount
// effect rather than a lazy initializer: server HTML is always rendered
// without a token, so seeding it during the first client render would cause a
// hydration mismatch in consumers that render differently when signed in.
export function useGitHubToken(): GitHubTokenState {
  const [token, setTokenState] = useState('');
  const [tokenVersion, setTokenVersion] = useState(0);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const storedToken = readStoredGitHubToken();
    if (storedToken !== '') {
      setTokenState(storedToken);
      setTokenVersion((version) => version + 1);
    }
    // Heal the middleware presence cookie for sessions whose token predates
    // it (or whose cookie expired while the stored token lives on).
    syncTokenPresenceCookie(storedToken !== '');
    setHydrated(true);
  }, []);

  const setToken = useCallback((nextToken: string) => {
    const normalizedToken = nextToken.trim();
    setTokenState(normalizedToken);
    setTokenVersion((version) => version + 1);
    writeStoredToken(normalizedToken);
  }, []);

  const clearToken = useCallback(() => {
    setToken('');
  }, [setToken]);

  return {
    clearToken,
    hasToken: token !== '',
    hydrated,
    setToken,
    token,
    tokenVersion,
  };
}

// Lets the OAuth completion page persist a token into the same storage slot
// the hook reads, so tokens from "Sign in with GitHub" and pasted PATs are
// indistinguishable to the rest of the app.
export function saveGitHubTokenToStorage(token: string): void {
  writeStoredToken(token.trim());
}

// The stored token as request headers: a Bearer Authorization header when a
// token is saved, empty otherwise. The single client-side spelling of
// "attach my token if I have one".
export function storedGitHubTokenHeaders(): HeadersInit {
  const token = readStoredGitHubToken();
  return token === '' ? {} : { Authorization: `Bearer ${token}` };
}

// Synchronous read of the stored token, for callers that need the answer
// before the hook's hydration effect runs (e.g. the require-login gate).
export function readStoredGitHubToken(): string {
  try {
    return globalThis.localStorage?.getItem(GITHUB_TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeStoredToken(token: string): void {
  try {
    if (token === '') {
      globalThis.localStorage?.removeItem(GITHUB_TOKEN_STORAGE_KEY);
    } else {
      globalThis.localStorage?.setItem(GITHUB_TOKEN_STORAGE_KEY, token);
    }
  } catch {
    // Browsers can disable storage; in-memory state still works for the page.
  }
  syncTokenPresenceCookie(token !== '');
}
