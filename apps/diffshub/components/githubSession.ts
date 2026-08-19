import { type OAuthTokenGrant, parseGrantRecord } from '@/lib/githubOAuthGrant';
import { type PlainFetch } from '@/lib/plainFetch';
import { readStoredJSON, writeStoredJSON } from '@/lib/storedJSON';
import { syncTokenPresenceCookie } from '@/lib/tokenPresenceCookie';

// Browser-side storage for the viewer's GitHub credentials, and the refresh
// logic that keeps an expiring one alive.
//
// Two localStorage entries:
//   - the token slot holds the bare access token, whatever its origin: a
//     pasted PAT, an OAuth App token, or a GitHub App user token. Every
//     request reader in the app looks only at this slot, so the auth method is
//     invisible to the rest of the code.
//   - the session slot exists only for GitHub App sign-ins with token
//     expiration enabled. It holds the refresh token and the absolute expiry
//     times, anchored to this browser's clock when the grant arrived. PATs and
//     non-expiring apps never write it, and refreshGitHubSessionIfNeeded is a
//     no-op without it.
//
// The token slot is exposed as an external store (subscribe + snapshot) so
// React consumers see every write — a refresh, a sign-out in another tab, a
// pasted PAT — through useSyncExternalStore rather than each keeping a copy.

const GITHUB_TOKEN_STORAGE_KEY = 'diffshub.github.token';
const GITHUB_SESSION_STORAGE_KEY = 'diffshub.github.session';

// Fired on window after every storage write. The native `storage` event only
// reaches *other* tabs; this covers the same one.
export const GITHUB_TOKEN_CHANGE_EVENT = 'diffshub:github-token-change';

export interface StoredGitHubSession {
  // Epoch ms after which the access token no longer works.
  expiresAt?: number;
  refreshToken?: string;
  // Epoch ms after which the refresh token itself is dead.
  refreshTokenExpiresAt?: number;
}

// Synchronous read of the stored token, for callers that need the answer
// outside React (fetch helpers, the require-login gate).
export function readStoredGitHubToken(): string {
  try {
    return (
      globalThis.window?.localStorage.getItem(GITHUB_TOKEN_STORAGE_KEY) ?? ''
    );
  } catch {
    return '';
  }
}

// The stored token as request headers: a Bearer Authorization header when a
// token is saved, empty otherwise. The single client-side spelling of
// "attach my token if I have one".
export function storedGitHubTokenHeaders(): HeadersInit {
  const token = readStoredGitHubToken();
  return token === '' ? {} : { Authorization: `Bearer ${token}` };
}

export function readStoredGitHubSession(): StoredGitHubSession | undefined {
  const parsed = readStoredJSON(GITHUB_SESSION_STORAGE_KEY);
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  return {
    expiresAt: readEpoch(record.expiresAt),
    refreshToken:
      typeof record.refreshToken === 'string' && record.refreshToken !== ''
        ? record.refreshToken
        : undefined,
    refreshTokenExpiresAt: readEpoch(record.refreshTokenExpiresAt),
  };
}

function readEpoch(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

// Saves a manually supplied token (a pasted PAT, or clearing with ''). Any
// refresh session belonged to the previous credential and is dropped with it.
export function saveGitHubTokenToStorage(token: string): void {
  writeStorage(token.trim(), undefined);
}

// Saves a grant from the OAuth flow or a refresh: the access token always,
// plus a session entry when GitHub issued lifetimes or a refresh token.
export function saveGitHubGrantToStorage(
  grant: OAuthTokenGrant,
  now: number = Date.now()
): void {
  const session: StoredGitHubSession = {
    expiresAt:
      grant.expiresIn == null ? undefined : now + grant.expiresIn * 1000,
    refreshToken: grant.refreshToken,
    refreshTokenExpiresAt:
      grant.refreshTokenExpiresIn == null
        ? undefined
        : now + grant.refreshTokenExpiresIn * 1000,
  };
  const hasSession = Object.values(session).some((value) => value != null);
  writeStorage(grant.accessToken.trim(), hasSession ? session : undefined);
}

function writeStorage(
  token: string,
  session: StoredGitHubSession | undefined
): void {
  try {
    if (token === '') {
      globalThis.window?.localStorage.removeItem(GITHUB_TOKEN_STORAGE_KEY);
    } else {
      globalThis.window?.localStorage.setItem(GITHUB_TOKEN_STORAGE_KEY, token);
    }
  } catch {
    // Browsers can disable storage; in-memory state still works for the page.
  }
  writeStoredJSON(GITHUB_SESSION_STORAGE_KEY, token === '' ? null : session);
  syncTokenPresenceCookie(token !== '');
  globalThis.window?.dispatchEvent(new Event(GITHUB_TOKEN_CHANGE_EVENT));
}

// --- External store for React ---------------------------------------------

export interface GitHubTokenSnapshot {
  token: string;
  // Bumps on every change to the token, for consumers that key a refetch on
  // "the credential changed" rather than on the token string itself.
  version: number;
}

const SERVER_TOKEN_SNAPSHOT: GitHubTokenSnapshot = { token: '', version: 0 };
let tokenSnapshot: GitHubTokenSnapshot | undefined;

// Stable-identity snapshot of the token slot: the same object is returned
// until the stored token actually changes, as useSyncExternalStore requires.
export function getGitHubTokenSnapshot(): GitHubTokenSnapshot {
  const token = readStoredGitHubToken();
  if (tokenSnapshot == null) {
    tokenSnapshot = { token, version: 0 };
  } else if (tokenSnapshot.token !== token) {
    tokenSnapshot = { token, version: tokenSnapshot.version + 1 };
  }
  return tokenSnapshot;
}

export function getServerGitHubTokenSnapshot(): GitHubTokenSnapshot {
  return SERVER_TOKEN_SNAPSHOT;
}

// Notifies on same-tab writes (the change event) and other-tab writes (the
// native storage event).
export function subscribeToGitHubToken(listener: () => void): () => void {
  window.addEventListener(GITHUB_TOKEN_CHANGE_EVENT, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(GITHUB_TOKEN_CHANGE_EVENT, listener);
    window.removeEventListener('storage', listener);
  };
}

// --- Refresh ---------------------------------------------------------------

// Refresh this far ahead of expiry so a request started just before the
// deadline never rides an already-dead token.
const REFRESH_LEAD_MS = 5 * 60 * 1000;

export type GitHubSessionRefreshOutcome =
  // No refreshable session (PAT, OAuth App, or non-expiring GitHub App).
  | 'none'
  // The stored token is good for a while yet; nothing was sent.
  | 'fresh'
  // A new token was minted and stored.
  | 'refreshed'
  // The refresh token is dead; the stored credentials were cleared and the
  // viewer must sign in again.
  | 'signed-out'
  // GitHub or the server was unreachable; the stored token is left as-is and
  // the next check tries again.
  | 'failed';

let inflightRefresh: Promise<GitHubSessionRefreshOutcome> | undefined;

// Whether the stored token is already past its expiry (not merely near it).
// False when the session carries no expiry.
export function isStoredGitHubTokenExpired(now: number = Date.now()): boolean {
  const expiresAt = readStoredGitHubSession()?.expiresAt;
  return expiresAt != null && expiresAt <= now;
}

// When the next proactive refresh is due (epoch ms), or undefined when the
// session has nothing to refresh. Lets the refresher sleep until then
// instead of polling.
export function nextGitHubRefreshDueAt(): number | undefined {
  const session = readStoredGitHubSession();
  if (session?.refreshToken == null || session.expiresAt == null) {
    return undefined;
  }
  return session.expiresAt - REFRESH_LEAD_MS;
}

// Refreshes the stored access token when it is about to expire. Single-flight:
// concurrent callers share one request, since GitHub rotates the refresh
// token and a second exchange with the same one would be rejected.
export function refreshGitHubSessionIfNeeded(
  fetcher: PlainFetch = fetch
): Promise<GitHubSessionRefreshOutcome> {
  inflightRefresh ??= runRefresh(fetcher).finally(() => {
    inflightRefresh = undefined;
  });
  return inflightRefresh;
}

async function runRefresh(
  fetcher: PlainFetch
): Promise<GitHubSessionRefreshOutcome> {
  const session = readStoredGitHubSession();
  if (readStoredGitHubToken() === '' || session?.refreshToken == null) {
    return 'none';
  }
  const now = Date.now();
  if (session.expiresAt != null && session.expiresAt - now > REFRESH_LEAD_MS) {
    return 'fresh';
  }
  if (
    session.refreshTokenExpiresAt != null &&
    session.refreshTokenExpiresAt <= now
  ) {
    saveGitHubTokenToStorage('');
    return 'signed-out';
  }

  let response: Response;
  try {
    response = await fetcher('/api/auth/github/refresh', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
  } catch {
    return 'failed';
  }

  if (response.status === 401) {
    saveGitHubTokenToStorage('');
    return 'signed-out';
  }
  if (!response.ok) {
    return 'failed';
  }

  let record: unknown;
  try {
    record = await response.json();
  } catch {
    return 'failed';
  }
  const grant =
    typeof record === 'object' && record !== null
      ? parseGrantRecord(record as Record<string, unknown>)
      : undefined;
  if (grant == null) {
    return 'failed';
  }
  saveGitHubGrantToStorage(grant);
  return 'refreshed';
}
