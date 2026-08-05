// Server-side pieces of the "Sign in with GitHub" flow. DiffsHub uses the
// standard OAuth web application flow: the login route redirects the browser
// to GitHub's authorize page with a random state pinned in an httpOnly cookie,
// and the callback route exchanges the returned code for a user access token.
// The token is then handed to the browser through a URL fragment on the
// /auth/github completion page (fragments never reach server logs), which
// stores it in the same localStorage slot the manual PAT flow uses — so every
// existing loader keeps working identically for both auth methods.

// Cookie carrying `${state} ${returnTo}` between the login redirect and the
// OAuth callback. Scoped to the auth routes so it rides along with nothing
// else.
export const OAUTH_STATE_COOKIE = 'diffshub-github-oauth-state';
export const OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;
export const OAUTH_CALLBACK_PATH = '/api/auth/github/callback';
export const OAUTH_COMPLETION_PATH = '/auth/github';

// Read requests can see private repository diffs, so ask for classic `repo`
// scope — OAuth apps (unlike fine-grained PATs) have no read-only repo scope.
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

// Only allow redirecting back to a same-origin path. Anything else (absolute
// URLs, protocol-relative //host paths, backslash tricks) falls back to the
// home page so the OAuth flow cannot be used as an open redirect.
export function sanitizeReturnTo(value: string | null | undefined): string {
  if (value == null || value === '') {
    return '/';
  }
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.startsWith('/\\')
  ) {
    return '/';
  }
  return value;
}

export function serializeOAuthState(payload: OAuthStatePayload): string {
  return `${payload.state} ${payload.returnTo}`;
}

export function parseOAuthState(
  cookieValue: string | null | undefined
): OAuthStatePayload | undefined {
  if (cookieValue == null || cookieValue === '') {
    return undefined;
  }
  const separatorIndex = cookieValue.indexOf(' ');
  if (separatorIndex <= 0) {
    return undefined;
  }
  return {
    state: cookieValue.slice(0, separatorIndex),
    returnTo: sanitizeReturnTo(cookieValue.slice(separatorIndex + 1)),
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
// redirect_uri. Behind a reverse proxy the request origin Next sees may be an
// internal address, so DIFFSHUB_PUBLIC_ORIGIN wins when set.
export function getPublicOrigin(requestOrigin: string): string {
  const configured = process.env.DIFFSHUB_PUBLIC_ORIGIN?.trim();
  if (configured == null || configured === '') {
    return requestOrigin;
  }
  return new URL(configured).origin;
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
      'User-Agent': 'pierre-diffshub',
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
