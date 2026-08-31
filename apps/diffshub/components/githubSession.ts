import { type OAuthTokenGrant, parseGrantRecord } from '@/lib/githubOAuthGrant';
import { parseBearerToken } from '@/lib/parseBearerToken';
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
// Session-scoped marker that the token slot was cleared because credentials
// died (expired, rejected, or unreadable by the server) rather than by an
// explicit sign-out. See stampReauthIntent.
const REAUTH_INTENT_STORAGE_KEY = 'diffshub.github.reauth';
// When the last automatic OAuth re-run was attempted, enforcing one hop per
// window: if the previous attempt was moments ago, the credentials it minted
// are already being rejected — a broken deployment — so the login page falls
// back to its form instead of bouncing against GitHub forever.
const REAUTH_ATTEMPT_STORAGE_KEY = 'diffshub.github.reauth-attempt';
const REAUTH_ATTEMPT_WINDOW_MS = 60_000;

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
export function storedGitHubTokenHeaders(): Record<string, string> {
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

// --- Re-authentication intent ----------------------------------------------

// Distinguishes "credentials died out from under the viewer" from "no
// credentials were ever saved" across the redirect to /login: the login page
// consumes the stamp and, when OAuth is available, skips the form and re-runs
// the GitHub flow directly — the viewer already chose their sign-in method,
// so a dead session should heal with one round trip, not a form.
export function stampReauthIntent(): void {
  try {
    globalThis.window?.sessionStorage.setItem(REAUTH_INTENT_STORAGE_KEY, '1');
  } catch {
    // Without sessionStorage the login page simply shows its normal form.
  }
}

// The login page's one question: did credentials just die, and may an
// automatic re-auth hop run? Consuming clears the intent and records the
// attempt, so the one-hop-per-window loop guard lives with the stamp rather
// than in the page.
export function consumeReauthIntent(now: number = Date.now()): boolean {
  try {
    const storage = globalThis.window?.sessionStorage;
    if (storage?.getItem(REAUTH_INTENT_STORAGE_KEY) == null) {
      return false;
    }
    storage.removeItem(REAUTH_INTENT_STORAGE_KEY);
    // Number(null) is 0, so a missing attempt stamp compares as ancient.
    if (
      now - Number(storage.getItem(REAUTH_ATTEMPT_STORAGE_KEY)) <
      REAUTH_ATTEMPT_WINDOW_MS
    ) {
      return false;
    }
    storage.setItem(REAUTH_ATTEMPT_STORAGE_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

// Sign-out for dead credentials: the emptied slot is what RequireLoginGate
// watches, so on require-login deployments this *is* the redirect to sign-in,
// and the stamp upgrades that redirect to the automatic OAuth re-run.
function clearGitHubTokenForReauth(
  expectedToken: string,
  expectedRefreshToken?: string
): boolean {
  if (
    readStoredGitHubToken() !== expectedToken ||
    (expectedRefreshToken != null &&
      readStoredGitHubSession()?.refreshToken !== expectedRefreshToken)
  ) {
    return false;
  }
  stampReauthIntent();
  saveGitHubTokenToStorage('');
  return true;
}

// Entry point for data loaders that saw a 401 with a credential attached.
// Refreshable sessions get a forced refresh: a merely-stale access token
// heals silently, and the refresh path below clears the slot itself when
// GitHub rejects the whole session. Anything else is unrecoverable
// client-side, so the credential is dropped with re-auth intent. Resolves
// the replacement token an idempotent request may retry with, or null when
// there is none.
export async function reportGitHubAuthFailure(
  response: { status: number },
  attemptedToken: string,
  fetcher: PlainFetch = fetch
): Promise<string | null> {
  if (response.status !== 401 || attemptedToken === '') {
    return null;
  }
  const currentToken = readStoredGitHubToken();
  if (currentToken !== attemptedToken) {
    // The response belongs to an older credential. It must not mutate the
    // replacement, but idempotent callers may retry with the current token.
    return currentToken === '' ? null : currentToken;
  }
  const session = readStoredGitHubSession();
  if (session?.refreshToken != null) {
    await refreshGitHubSessionIfNeeded(
      fetcher,
      true,
      attemptedToken,
      session.refreshToken
    );
    const refreshedToken = readStoredGitHubToken();
    return refreshedToken !== '' && refreshedToken !== attemptedToken
      ? refreshedToken
      : null;
  }
  clearGitHubTokenForReauth(attemptedToken);
  return null;
}

// The response-side sibling of storedGitHubTokenHeaders: one spelling of
// "call a DiffsHub API with my token and let the session react if it is
// dead". Explicit headers win over the attached token, and every response
// passes through reportGitHubAuthFailure before the caller sees it.
export async function githubFetch(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  fetcher: PlainFetch = fetch
): Promise<Response> {
  // A Request input carries its own headers and method; init replaces the
  // headers and overrides the method (fetch(input, init) semantics), so
  // resolve those before deciding whether to attach the stored token or retry.
  const request = input instanceof Request ? input : undefined;
  const headers = new Headers(init?.headers ?? request?.headers);
  if (!headers.has('authorization')) {
    const storedAuthorization = storedGitHubTokenHeaders().Authorization;
    if (storedAuthorization != null) {
      headers.set('authorization', storedAuthorization);
    }
  }
  const attemptedToken = parseBearerToken(headers.get('authorization')) ?? '';
  const response = await fetcher(input, {
    ...init,
    headers,
  });
  const retryToken = await reportGitHubAuthFailure(
    response,
    attemptedToken,
    fetcher
  );
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  if (retryToken == null || (method !== 'GET' && method !== 'HEAD')) {
    return response;
  }

  const retryHeaders = new Headers(headers);
  retryHeaders.set('authorization', `Bearer ${retryToken}`);
  const retryResponse = await fetcher(input, {
    ...init,
    headers: retryHeaders,
  });
  await reportGitHubAuthFailure(retryResponse, retryToken, fetcher);
  return retryResponse;
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

interface InflightRefresh {
  forced: boolean;
  promise: Promise<GitHubSessionRefreshOutcome>;
}

const inflightRefreshByCredential = new Map<string, InflightRefresh>();
const GITHUB_REFRESH_LOCK_NAME = 'diffshub.github.refresh';

// Whether the stored token is already past its expiry (not merely near it).
// False when the session carries no expiry.
export function isStoredGitHubTokenExpired(now: number = Date.now()): boolean {
  const expiresAt = readStoredGitHubSession()?.expiresAt;
  return expiresAt != null && expiresAt <= now;
}

// When the next proactive session check is due (epoch ms), or undefined when
// the session carries no expiry. Lets the refresher sleep until then instead
// of polling. With a refresh token the check runs ahead of expiry to mint the
// next token; without one (a deployment that disables refresh tokens) it runs
// at expiry to clear the dead token and prompt a fresh sign-in.
export function nextGitHubRefreshDueAt(): number | undefined {
  const session = readStoredGitHubSession();
  if (session?.expiresAt == null) {
    return undefined;
  }
  return session.refreshToken == null
    ? session.expiresAt
    : session.expiresAt - REFRESH_LEAD_MS;
}

// Refreshes the stored access token when it is about to expire — or
// immediately with `force`, for callers who just saw the current token
// rejected regardless of its expected lifetime. Single-flight: concurrent
// callers share one request, since GitHub rotates the refresh token and a
// second exchange with the same one would be rejected.
export function refreshGitHubSessionIfNeeded(
  fetcher: PlainFetch = fetch,
  force = false,
  expectedToken: string = readStoredGitHubToken(),
  expectedRefreshToken: string | undefined = readStoredGitHubSession()
    ?.refreshToken
): Promise<GitHubSessionRefreshOutcome> {
  const refreshKey = JSON.stringify([expectedToken, expectedRefreshToken]);
  const existing = inflightRefreshByCredential.get(refreshKey);
  if (existing != null) {
    if (!force || existing.forced) {
      return existing.promise;
    }
    // A 401-triggered refresh may arrive while a proactive check is waiting
    // for the cross-tab lock. If that check later decides the credential is
    // still fresh, follow it with the forced exchange the 401 requires. When
    // it actually refreshed (or failed trying), sharing its outcome is enough.
    return existing.promise.then((outcome) =>
      outcome === 'fresh' &&
      sessionGenerationStillMatches(expectedToken, expectedRefreshToken)
        ? refreshGitHubSessionIfNeeded(
            fetcher,
            true,
            expectedToken,
            expectedRefreshToken
          )
        : outcome
    );
  }
  const pending = withCrossTabRefreshLock(() =>
    runRefresh(fetcher, force, expectedToken, expectedRefreshToken)
  ).finally(() => {
    // The entry blocks re-registration of this key until it is deleted here,
    // so it can only ever hold this promise.
    inflightRefreshByCredential.delete(refreshKey);
  });
  inflightRefreshByCredential.set(refreshKey, {
    forced: force,
    promise: pending,
  });
  return pending;
}

function withCrossTabRefreshLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = globalThis.navigator?.locks;
  return locks == null
    ? operation()
    : locks.request(GITHUB_REFRESH_LOCK_NAME, operation);
}

async function runRefresh(
  fetcher: PlainFetch,
  force: boolean,
  expectedToken: string,
  expectedRefreshToken: string | undefined
): Promise<GitHubSessionRefreshOutcome> {
  const storedToken = readStoredGitHubToken();
  const session = readStoredGitHubSession();
  if (storedToken === '' || session == null) {
    return 'none';
  }
  if (
    storedToken !== expectedToken ||
    session.refreshToken !== expectedRefreshToken
  ) {
    return 'fresh';
  }
  const now = Date.now();
  if (session.refreshToken == null) {
    // An expiring token with nothing to refresh it (the deployment omits
    // refresh tokens): once it dies the only recovery is a fresh sign-in, so
    // clear it and let the sign-in prompt surface.
    if (session.expiresAt == null || session.expiresAt > now) {
      return 'none';
    }
    return clearGitHubTokenForReauth(expectedToken) ? 'signed-out' : 'fresh';
  }
  if (
    !force &&
    session.expiresAt != null &&
    session.expiresAt - now > REFRESH_LEAD_MS
  ) {
    return 'fresh';
  }
  if (
    session.refreshTokenExpiresAt != null &&
    session.refreshTokenExpiresAt <= now
  ) {
    return clearGitHubTokenForReauth(expectedToken, session.refreshToken)
      ? 'signed-out'
      : 'fresh';
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
    return clearGitHubTokenForReauth(expectedToken, session.refreshToken)
      ? 'signed-out'
      : 'fresh';
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
  if (!sessionGenerationStillMatches(expectedToken, session.refreshToken)) {
    return 'fresh';
  }
  saveGitHubGrantToStorage(grant);
  return 'refreshed';
}

function sessionGenerationStillMatches(
  accessToken: string,
  refreshToken: string | undefined
): boolean {
  return (
    readStoredGitHubToken() === accessToken &&
    readStoredGitHubSession()?.refreshToken === refreshToken
  );
}
