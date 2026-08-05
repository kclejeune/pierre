import { type NextRequest, NextResponse } from 'next/server';

import {
  getGitHubEnvironment,
  getGitHubOAuthConfig,
} from '@/lib/githubEnvironment';
import {
  buildCompletionURL,
  exchangeOAuthCode,
  getPublicOrigin,
  OAUTH_CALLBACK_PATH,
  OAUTH_STATE_COOKIE,
  parseOAuthState,
} from '@/lib/githubOAuth';

// Completes the OAuth flow: validates the state cookie, exchanges the code
// for a user access token, and forwards the browser to the completion page
// with the token in the URL fragment (never in a query string or log line).
// All failure branches land on the same completion page with a readable error.
export async function GET(request: NextRequest) {
  const oauthConfig = getGitHubOAuthConfig();
  if (oauthConfig == null) {
    return redirectToCompletion(request, {
      error: 'GitHub sign-in is not configured for this deployment.',
    });
  }

  const searchParams = request.nextUrl.searchParams;
  const statePayload = parseOAuthState(
    request.cookies.get(OAUTH_STATE_COOKIE)?.value
  );
  const state = searchParams.get('state');
  const code = searchParams.get('code');

  if (statePayload == null || state == null || state !== statePayload.state) {
    return redirectToCompletion(request, {
      error: 'The sign-in session expired or was invalid. Please try again.',
    });
  }

  // GitHub reports user-denied and misconfiguration cases as error params.
  const upstreamError =
    searchParams.get('error_description') ?? searchParams.get('error');
  if (code == null || code === '') {
    return redirectToCompletion(request, {
      error: upstreamError ?? 'GitHub did not return an authorization code.',
      returnTo: statePayload.returnTo,
    });
  }

  const environment = getGitHubEnvironment();
  const origin = getPublicOrigin(request.headers, request.nextUrl.origin);
  try {
    const token = await exchangeOAuthCode({
      clientId: oauthConfig.clientId,
      clientSecret: oauthConfig.clientSecret,
      code,
      redirectURI: `${origin}${OAUTH_CALLBACK_PATH}`,
      webURL: environment.webURL,
    });
    return redirectToCompletion(request, {
      returnTo: statePayload.returnTo,
      token,
    });
  } catch (error) {
    return redirectToCompletion(request, {
      error:
        error instanceof Error
          ? error.message
          : 'GitHub sign-in failed unexpectedly.',
      returnTo: statePayload.returnTo,
    });
  }
}

function redirectToCompletion(
  request: NextRequest,
  options: { error?: string; returnTo?: string; token?: string }
): NextResponse {
  // The browser-facing redirect must use the public origin too — the request
  // origin behind a proxy is the container bind address.
  const response = NextResponse.redirect(
    new URL(
      buildCompletionURL(options),
      getPublicOrigin(request.headers, request.nextUrl.origin)
    )
  );
  // One-shot cookie: always cleared once the callback has run.
  response.cookies.set(OAUTH_STATE_COOKIE, '', {
    httpOnly: true,
    maxAge: 0,
    path: '/api/auth/github',
    sameSite: 'lax',
  });
  return response;
}
