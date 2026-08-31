// The "Sign in with GitHub" flow: the login route redirects the browser to
// GitHub's authorize page with a random state pinned in an httpOnly cookie,
// and the callback route exchanges the returned code for a user access token.
// The flow is the same for an OAuth App and a GitHub App (user-to-server
// authorization). The grant is handed to the browser through a URL fragment
// on the /auth/github completion page (fragments never reach server logs),
// which stores it in the same localStorage slot the manual PAT flow uses — so
// every existing loader keeps working identically for both auth methods.
//
// Mostly server-side (the token endpoint calls need the client secret), but
// sanitizeReturnTo is shared with the login and completion pages. The grant
// itself — its shape and wire encoding — lives in ./githubOAuthGrant so
// browser code never has to import this module for it.

import {
  getRefreshTokenMaxTTLSeconds,
  getTokenEncryptionKey,
  GITHUB_USER_AGENT,
} from './githubEnvironment';
import {
  type OAuthTokenGrant,
  parseGrantRecord,
  serializeGrantRecord,
} from './githubOAuthGrant';
import { type PlainFetch } from './plainFetch';
import {
  isWrappedRefreshToken,
  nowSeconds,
  unwrapRefreshToken,
  wrapRefreshToken,
} from './refreshTokenWrap';
import {
  isSealedToken,
  openSealedRefreshToken,
  sealAccessToken,
  sealRefreshToken,
} from './tokenSeal';

// Cookie carrying the JSON-encoded state payload between the login redirect
// and the OAuth callback. Scoped to the auth routes so it rides along with
// nothing else.
export const OAUTH_STATE_COOKIE = 'diffshub-github-oauth-state';
export const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;
export const OAUTH_CALLBACK_PATH = '/api/auth/github/callback';
const OAUTH_COMPLETION_PATH = '/auth/github';

// Read requests can see private repository diffs, so ask for classic `repo`
// scope — OAuth apps (unlike fine-grained PATs) have no read-only repo scope.
// GitHub Apps ignore this parameter entirely: their tokens carry the
// permissions configured on the app (Contents and Pull requests read/write),
// narrowed to the repositories where the app is installed.
const OAUTH_SCOPE = 'repo';

export interface OAuthStatePayload {
  returnTo: string;
  state: string;
}

// Throwaway origin the return path is resolved against. Reserved TLD (RFC
// 2606) so it can never collide with a real deployment host.
const RETURN_TO_PROBE_ORIGIN = 'https://diffshub.invalid';

// Only allow redirecting back to a same-origin path. Anything else (absolute
// URLs, protocol-relative //host paths, backslash tricks) falls back to the
// home page so the OAuth flow cannot be used as an open redirect.
//
// The value is resolved against a throwaway origin rather than prefix-matched,
// because the URL parser strips every ASCII tab, LF, and CR from its input
// before parsing: "/\n/evil.example" passes a startsWith('//') test but the
// browser still loads it as https://evil.example. Resolving first means the
// value is judged the way the browser will actually interpret it, and the
// return value is rebuilt from the parsed parts so only a path survives.
export function sanitizeReturnTo(value: string | null | undefined): string {
  if (value == null || value === '') {
    return '/';
  }

  let resolved: URL;
  try {
    resolved = new URL(value, RETURN_TO_PROBE_ORIGIN);
  } catch {
    return '/';
  }
  if (resolved.origin !== RETURN_TO_PROBE_ORIGIN) {
    return '/';
  }

  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

export function serializeOAuthState(payload: OAuthStatePayload): string {
  return JSON.stringify(payload);
}

export function parseOAuthState(
  cookieValue: string | null | undefined
): OAuthStatePayload | undefined {
  if (cookieValue == null || cookieValue === '') {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cookieValue);
  } catch {
    return undefined;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as OAuthStatePayload).state !== 'string' ||
    typeof (parsed as OAuthStatePayload).returnTo !== 'string'
  ) {
    return undefined;
  }

  const payload = parsed as OAuthStatePayload;
  return {
    state: payload.state,
    returnTo: sanitizeReturnTo(payload.returnTo),
  };
}

export function buildAuthorizeURL(options: {
  clientId: string;
  redirectURI: string;
  state: string;
  webURL: string;
}): string {
  const url = new URL(`${options.webURL}/login/oauth/authorize`);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', options.redirectURI);
  url.searchParams.set('scope', OAUTH_SCOPE);
  url.searchParams.set('state', options.state);
  return url.href;
}

// The deployment's externally visible origin, used to build the OAuth
// redirect_uri and browser-facing redirects. Next's standalone server reports
// its bind address (e.g. http://0.0.0.0:3000) as the request origin, so that
// is only a last resort: an explicit DIFFSHUB_PUBLIC_ORIGIN wins, then the
// proxy-forwarded host and protocol. Trusting these headers is safe here
// because GitHub validates redirect_uri against the registered callback URL,
// so a forged Host can only produce a sign-in that GitHub rejects.
export function getPublicOrigin(
  headers: Headers,
  requestOrigin: string
): string {
  const configured = process.env.DIFFSHUB_PUBLIC_ORIGIN?.trim();
  if (configured != null && configured !== '') {
    return new URL(configured).origin;
  }

  const host = headers.get('x-forwarded-host') ?? headers.get('host');
  if (host != null && host !== '') {
    // Proxies may append to an existing header, so only the first value
    // counts. Absent a forwarded protocol (direct access), keep the request's.
    const protocol =
      headers.get('x-forwarded-proto')?.split(',')[0]?.trim() ??
      new URL(requestOrigin).protocol.replace(':', '');
    try {
      return new URL(`${protocol}://${host}`).origin;
    } catch {
      // Fall through to the request origin on a malformed header.
    }
  }

  return requestOrigin;
}

// Redirect target for the completion page: returnTo travels as a query param
// while the grant rides in the fragment so it never appears in request lines
// or proxy logs. The completion page strips it from history immediately.
export function buildCompletionURL(options: {
  error?: string;
  grant?: OAuthTokenGrant;
  returnTo?: string;
}): string {
  const searchParams = new URLSearchParams();
  if (options.returnTo != null && options.returnTo !== '/') {
    searchParams.set('returnTo', options.returnTo);
  }
  if (options.error != null) {
    searchParams.set('error', options.error);
  }
  const query = searchParams.size > 0 ? `?${searchParams}` : '';
  const fragment =
    options.grant != null
      ? `#${new URLSearchParams(serializeGrantRecord(options.grant))}`
      : '';
  return `${OAUTH_COMPLETION_PATH}${query}${fragment}`;
}

// Exchanges the authorization code for a user access token. GitHub reports
// failures with a 200 + `error` body, so both shapes are normalized to a
// thrown Error with GitHub's description when available.
export async function exchangeOAuthCode(options: {
  clientId: string;
  clientSecret: string;
  code: string;
  fetcher?: PlainFetch;
  redirectURI: string;
  webURL: string;
}): Promise<OAuthTokenGrant> {
  return requestOAuthToken({
    clientSecret: options.clientSecret,
    fetcher: options.fetcher,
    grantParams: {
      client_id: options.clientId,
      code: options.code,
      redirect_uri: options.redirectURI,
    },
    rejectionPrefix: 'GitHub rejected the sign-in',
    webURL: options.webURL,
  });
}

// The pure half of max-TTL enforcement: strips or clamps a grant's refresh
// token to the session's remaining allowance. undefined leaves the grant
// untouched (no cap configured), a non-positive remainder drops the refresh
// token entirely, and a positive remainder clamps the lifetime the browser
// is told — including for a refresh token GitHub issued without one.
export function clampRefreshTokenGrant(
  grant: OAuthTokenGrant,
  remainingSeconds: number | undefined
): OAuthTokenGrant {
  if (remainingSeconds == null) {
    return grant;
  }
  if (remainingSeconds <= 0) {
    const {
      refreshToken: _refreshToken,
      refreshTokenExpiresIn: _refreshTokenExpiresIn,
      ...rest
    } = grant;
    return rest;
  }
  if (grant.refreshToken == null) {
    return grant;
  }
  return {
    ...grant,
    refreshTokenExpiresIn: Math.min(
      grant.refreshTokenExpiresIn ?? Infinity,
      remainingSeconds
    ),
  };
}

// Applies the deployment's browser-credential policies to a freshly minted
// grant: the max-TTL clamp (DIFFSHUB_REFRESH_TOKEN_MAX_TTL, see
// refreshTokenWrap) and at-rest encryption (DIFFSHUB_TOKEN_ENCRYPTION_KEY,
// see tokenSeal). Called inside requestOAuthToken — the one place grants are
// constructed — so no grant can leave this module unchecked, whatever route
// obtained it. The session is anchored to `issuedAtSeconds` (the original
// authorization time on a refresh) or to now on a first sign-in.
async function interceptGrant(
  grant: OAuthTokenGrant,
  clientSecret: string,
  issuedAtSeconds?: number
): Promise<OAuthTokenGrant> {
  const now = nowSeconds();
  const issuedAt = issuedAtSeconds ?? now;
  const maxTTL = getRefreshTokenMaxTTLSeconds();
  const policed =
    maxTTL == null
      ? grant
      : clampRefreshTokenGrant(grant, issuedAt + maxTTL - now);

  const key = getTokenEncryptionKey();
  if (key == null) {
    // Without encryption, the max-TTL policy still needs the authorization
    // time bound to the refresh token, so it ships in the HMAC wrap.
    if (maxTTL == null || policed.refreshToken == null) {
      return policed;
    }
    return {
      ...policed,
      refreshToken: await wrapRefreshToken(
        policed.refreshToken,
        issuedAt,
        clientSecret
      ),
    };
  }

  // Sealed envelopes carry the authorization time as authenticated data, so
  // they subsume the HMAC wrap rather than layering on it.
  const sealed: OAuthTokenGrant = {
    ...policed,
    accessToken: await sealAccessToken(policed.accessToken, key),
  };
  if (policed.refreshToken != null) {
    sealed.refreshToken = await sealRefreshToken(
      policed.refreshToken,
      issuedAt,
      key
    );
  }
  return sealed;
}

// GitHub's error code for a refresh token that is expired, revoked, or was
// already used (GitHub rotates refresh tokens on every refresh). The session
// cannot be recovered from it — the viewer has to sign in again — which is
// why callers treat it differently from a transient upstream failure.
const BAD_REFRESH_TOKEN_ERROR = 'bad_refresh_token';

export class OAuthRefreshRejectedError extends Error {}

// Mints a fresh user access token from a refresh token (GitHub Apps with
// token expiration enabled). Throws OAuthRefreshRejectedError for every
// unrecoverable-session case — the viewer must sign in again — and a plain
// Error for transient failures. The max-TTL gates (see refreshTokenWrap)
// run before contacting GitHub; past them, GitHub itself may still reject
// the token as expired, revoked, or already used.
export async function refreshOAuthToken(options: {
  clientId: string;
  clientSecret: string;
  fetcher?: PlainFetch;
  refreshToken: string;
  webURL: string;
}): Promise<OAuthTokenGrant> {
  const maxTTL = getRefreshTokenMaxTTLSeconds();
  if (maxTTL === 0) {
    throw new OAuthRefreshRejectedError(
      'Refresh tokens are disabled on this deployment.'
    );
  }

  // Unwrapping keys off the token's own shape rather than the current
  // config, so wrapped sessions keep working if the operator later removes
  // the cap; the age gate applies only while a cap is set.
  let refreshToken = options.refreshToken;
  let issuedAt: number | undefined;
  if (isSealedToken(refreshToken)) {
    const key = getTokenEncryptionKey();
    const opened =
      key == null ? undefined : await openSealedRefreshToken(refreshToken, key);
    if (opened == null) {
      // A sealed envelope that cannot be opened — the key was rotated or
      // removed, or the value was tampered with — is an unrecoverable
      // session, unlike a bare token, which may simply predate the key.
      throw new OAuthRefreshRejectedError(
        "The refresh token cannot be read under this deployment's encryption key. Sign in again."
      );
    }
    ({ issuedAt, refreshToken } = opened);
  } else if (isWrappedRefreshToken(refreshToken)) {
    const unwrapped = await unwrapRefreshToken(
      refreshToken,
      options.clientSecret
    );
    if (unwrapped != null) {
      ({ issuedAt, refreshToken } = unwrapped);
    }
  }
  if (maxTTL != null) {
    if (issuedAt == null) {
      throw new OAuthRefreshRejectedError(
        "The refresh token was not issued under this deployment's session policy."
      );
    }
    if (issuedAt + maxTTL <= nowSeconds()) {
      throw new OAuthRefreshRejectedError(
        'The session reached its maximum age. Sign in again.'
      );
    }
  }

  return requestOAuthToken({
    clientSecret: options.clientSecret,
    fetcher: options.fetcher,
    grantParams: {
      client_id: options.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    },
    issuedAtSeconds: issuedAt,
    rejectionPrefix: 'GitHub rejected the session refresh',
    webURL: options.webURL,
  });
}

async function requestOAuthToken(options: {
  // Authenticates the exchange and keys the wrap in interceptGrant; explicit
  // so
  // a future grant flow cannot silently wrap under a missing secret.
  clientSecret: string;
  fetcher?: PlainFetch;
  // The grant-specific body fields (code, refresh_token, ...); the secret is
  // added here so callers cannot forget it.
  grantParams: Record<string, string>;
  // Original authorization time to carry into the new grant's wrap; absent on
  // a first sign-in, where the session starts now.
  issuedAtSeconds?: number;
  rejectionPrefix: string;
  webURL: string;
}): Promise<OAuthTokenGrant> {
  const { clientSecret, fetcher = fetch, rejectionPrefix } = options;
  const response = await fetcher(`${options.webURL}/login/oauth/access_token`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': GITHUB_USER_AGENT,
    },
    body: JSON.stringify({
      ...options.grantParams,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    throw new Error(
      `GitHub token exchange failed (${response.status} ${response.statusText}).`
    );
  }

  const data: unknown = await response.json();
  if (typeof data !== 'object' || data === null) {
    throw new Error('GitHub token exchange returned an invalid response.');
  }

  const record = data as Record<string, unknown>;
  const grant = parseGrantRecord(record);
  if (grant != null) {
    return interceptGrant(grant, clientSecret, options.issuedAtSeconds);
  }

  const description = record.error_description ?? record.error;
  const message =
    typeof description === 'string' && description !== ''
      ? `${rejectionPrefix}: ${description}`
      : 'GitHub token exchange did not return a token.';
  if (record.error === BAD_REFRESH_TOKEN_ERROR) {
    throw new OAuthRefreshRejectedError(message);
  }
  throw new Error(message);
}
