import { type NextRequest, NextResponse } from 'next/server';

import {
  getGitHubEnvironment,
  getGitHubOAuthConfig,
} from '@/lib/githubEnvironment';
import {
  buildAuthorizeURL,
  getPublicOrigin,
  OAUTH_CALLBACK_PATH,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
  sanitizeReturnTo,
  serializeOAuthState,
} from '@/lib/githubOAuth';

// Starts the "Sign in with GitHub" flow: pins a random state (plus the
// sanitized return path) in an httpOnly cookie and redirects the browser to
// the configured GitHub instance's authorize page.
export function GET(request: NextRequest) {
  const oauthConfig = getGitHubOAuthConfig();
  if (oauthConfig == null) {
    return NextResponse.json(
      { error: 'GitHub sign-in is not configured for this deployment.' },
      { status: 404 }
    );
  }

  const environment = getGitHubEnvironment();
  const origin = getPublicOrigin(request.nextUrl.origin);
  const returnTo = sanitizeReturnTo(
    request.nextUrl.searchParams.get('returnTo')
  );
  const state = crypto.randomUUID();

  const response = NextResponse.redirect(
    buildAuthorizeURL({
      clientId: oauthConfig.clientId,
      redirectURI: `${origin}${OAUTH_CALLBACK_PATH}`,
      state,
      webURL: environment.webURL,
    })
  );
  response.cookies.set(
    OAUTH_STATE_COOKIE,
    serializeOAuthState({ returnTo, state }),
    {
      httpOnly: true,
      maxAge: OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
      path: '/api/auth/github',
      sameSite: 'lax',
      secure: origin.startsWith('https:'),
    }
  );
  return response;
}
