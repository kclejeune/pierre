import { type NextRequest } from 'next/server';

import {
  createGitHubAPIURL,
  createGitHubJSONHeaders,
  getGitHubEnvironment,
  rejectTokenlessRequestWhenLoginRequired,
} from '@/lib/githubEnvironment';
import {
  createGitHubFailureResponse,
  createUnreachableResponse,
} from '@/lib/githubProxyResponse';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseBearerToken } from '@/lib/parseBearerToken';

// Proxies user lookups on the configured GitHub instance so the browser never
// talks to the GitHub API cross-origin. Without a `login` parameter this
// resolves the signed-in identity behind the caller's token (GET /user, for
// comment authorship); with one it resolves that user's public profile
// (GET /users/{login}), which supplies the display name behind avatar
// initials.
export async function GET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }

  const token = parseBearerToken(request.headers.get('authorization'));
  const login = request.nextUrl.searchParams.get('login');
  if (login == null && token == null) {
    return createJSONResponse(
      { error: 'Resolving the GitHub user requires a token.' },
      { status: 401 }
    );
  }

  const environment = getGitHubEnvironment();

  // The identity lookup is token-scoped and never cached; public profiles
  // are near-static, so cache those briefly to spare one upstream call per
  // comment author per viewer.
  let url: string;
  let init: RequestInit;
  if (login == null) {
    url = createGitHubAPIURL(environment, '/user');
    init = { headers: createGitHubJSONHeaders(token), cache: 'no-store' };
  } else {
    url = createGitHubAPIURL(
      environment,
      `/users/${encodeURIComponent(login)}`
    );
    init = {
      headers: createGitHubJSONHeaders(token),
      next: { revalidate: 300 },
    };
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    return createUnreachableResponse(environment);
  }

  if (!response.ok) {
    return await createGitHubFailureResponse(response);
  }

  const user = (await response.json()) as {
    avatar_url?: unknown;
    login?: unknown;
    name?: unknown;
  };
  if (typeof user.login !== 'string' || typeof user.avatar_url !== 'string') {
    return createJSONResponse(
      { error: 'GitHub returned an unexpected user payload.' },
      { status: 502 }
    );
  }

  return createJSONResponse({
    avatarUrl: user.avatar_url,
    login: user.login,
    name: typeof user.name === 'string' ? user.name : null,
  });
}
