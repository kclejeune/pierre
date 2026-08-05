import { type NextRequest } from 'next/server';

import {
  createGitHubAPIURL,
  createGitHubJSONHeaders,
  getFallbackGitHubToken,
  getGitHubEnvironment,
} from '@/lib/githubEnvironment';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseBearerToken } from '@/lib/parseBearerToken';

// Proxies user lookups on the configured GitHub instance so the browser never
// talks to the GitHub API cross-origin. Without a `login` parameter this
// resolves the signed-in identity behind the caller's token (GET /user, for
// comment authorship); with one it resolves that user's public profile
// (GET /users/{login}), which supplies the display name behind avatar
// initials.
export async function GET(request: NextRequest) {
  const token = parseBearerToken(request.headers.get('authorization'));
  const login = request.nextUrl.searchParams.get('login');
  if (login == null && token == null) {
    return createJSONResponse(
      { error: 'Resolving the GitHub user requires a token.' },
      { status: 401 }
    );
  }

  const environment = getGitHubEnvironment();
  let response: Response;
  try {
    response = await fetch(
      createGitHubAPIURL(
        environment,
        login == null ? '/user' : `/users/${encodeURIComponent(login)}`
      ),
      {
        headers: createGitHubJSONHeaders(token ?? getFallbackGitHubToken()),
        cache: 'no-store',
      }
    );
  } catch {
    return createJSONResponse(
      { error: `Could not reach ${environment.host}.` },
      { status: 502 }
    );
  }

  if (!response.ok) {
    return createJSONResponse(
      { error: `GitHub responded with ${response.status}.` },
      { status: response.status === 401 ? 401 : 502 }
    );
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
