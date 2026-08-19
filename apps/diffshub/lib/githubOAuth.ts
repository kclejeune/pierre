// Server-side pieces of the "Sign in with GitHub" flow. DiffsHub uses the
// standard OAuth web application flow, which is the same for an OAuth App and
// a GitHub App (user-to-server authorization): the login route redirects the
// browser to GitHub's authorize page with a random state pinned in an
// httpOnly cookie, and the callback route exchanges the returned code for a
// user access token.
// The token is then handed to the browser through a URL fragment on the
// /auth/github completion page (fragments never reach server logs), which
// stores it in the same localStorage slot the manual PAT flow uses — so every
// existing loader keeps working identically for both auth methods.

import { GITHUB_USER_AGENT } from './githubEnvironment';

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

// Plain call signature (rather than `typeof fetch`) so tests can inject a
// stub without satisfying Bun's fetch namespace extras like `preconnect`.
type OAuthFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => ReturnType<typeof fetch>;

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
// while the token rides in the fragment so it never appears in request lines
// or proxy logs. The completion page strips it from history immediately.
export function buildCompletionURL(options: {
  error?: string;
  returnTo?: string;
  token?: string;
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
    options.token != null ? `#token=${encodeURIComponent(options.token)}` : '';
  return `${OAUTH_COMPLETION_PATH}${query}${fragment}`;
}

// Exchanges the authorization code for a user access token. GitHub reports
// failures with a 200 + `error` body, so both shapes are normalized to a
// thrown Error with GitHub's description when available.
export async function exchangeOAuthCode(options: {
  clientId: string;
  clientSecret: string;
  code: string;
  fetcher?: OAuthFetch;
  redirectURI: string;
  webURL: string;
}): Promise<string> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(`${options.webURL}/login/oauth/access_token`, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': GITHUB_USER_AGENT,
    },
    body: JSON.stringify({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code: options.code,
      redirect_uri: options.redirectURI,
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
  const accessToken = record.access_token;
  if (typeof accessToken === 'string' && accessToken !== '') {
    return accessToken;
  }

  const description = record.error_description ?? record.error;
  throw new Error(
    typeof description === 'string' && description !== ''
      ? `GitHub rejected the sign-in: ${description}`
      : 'GitHub token exchange did not return a token.'
  );
}
