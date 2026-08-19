import { type NextRequest } from 'next/server';

import {
  getGitHubEnvironment,
  getGitHubOAuthConfig,
} from '@/lib/githubEnvironment';
import {
  OAuthRefreshRejectedError,
  refreshOAuthToken,
} from '@/lib/githubOAuth';
import { serializeGrantRecord } from '@/lib/githubOAuthGrant';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseJSONBody } from '@/lib/parseJSONBody';

// Mints the next user access token from a refresh token, for GitHub App
// sign-ins with token expiration enabled. The browser owns the session (the
// server keeps no state), so it posts the refresh token here and the route
// completes the exchange with the client secret the browser must never see.
// The route is deliberately unauthenticated: the only proof it needs is the
// refresh token itself, which GitHub validates and rotates on every use.
//
// Responses the client distinguishes:
//   200 — a new grant in GitHub's own snake_case shape (see githubOAuthGrant).
//         GitHub rotates refresh tokens, so the response carries the
//         replacement and the submitted one is now dead.
//   401 — GitHub rejected the refresh token (expired, revoked, or already
//         used). The session cannot be recovered; the viewer signs in again.
//   502 — GitHub was unreachable or answered unexpectedly. The session is
//         still valid and the client should simply try again later.
export async function POST(request: NextRequest) {
  const oauthConfig = getGitHubOAuthConfig();
  if (oauthConfig == null) {
    return createJSONResponse(
      { error: 'GitHub sign-in is not configured for this deployment.' },
      { status: 404 }
    );
  }

  const body = await parseJSONBody(request);
  const refreshToken =
    typeof body?.refreshToken === 'string' ? body.refreshToken.trim() : '';
  if (refreshToken === '') {
    return createJSONResponse(
      { error: 'refreshToken is required.' },
      { status: 400 }
    );
  }

  try {
    const grant = await refreshOAuthToken({
      clientId: oauthConfig.clientId,
      clientSecret: oauthConfig.clientSecret,
      refreshToken,
      webURL: getGitHubEnvironment().webURL,
    });
    return createJSONResponse(serializeGrantRecord(grant));
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'GitHub session refresh failed.';
    return createJSONResponse(
      { error: message },
      { status: error instanceof OAuthRefreshRejectedError ? 401 : 502 }
    );
  }
}
