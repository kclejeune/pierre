import { type NextRequest } from 'next/server';

import {
  createGitHubAPIURL,
  getGitHubEnvironment,
  GITHUB_API_VERSION,
  GITHUB_USER_AGENT,
} from '@/lib/githubEnvironment';
import { parseBearerToken } from '@/lib/parseBearerToken';

// Proxies GET /user on the configured GitHub instance so the browser can
// resolve the signed-in identity (login + avatar) for comment authorship
// without talking to the GitHub API cross-origin.
export async function GET(request: NextRequest) {
  const token = parseBearerToken(request.headers.get('authorization'));
  if (token == null) {
    return createJSONResponse(
      { error: 'Resolving the GitHub user requires a token.' },
      { status: 401 }
    );
  }

  const environment = getGitHubEnvironment();
  let response: Response;
  try {
    response = await fetch(createGitHubAPIURL(environment, '/user'), {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': GITHUB_USER_AGENT,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
      cache: 'no-store',
    });
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

function createJSONResponse(
  body: unknown,
  options: { status?: number } = {}
): Response {
  return Response.json(body, {
    status: options.status ?? 200,
    headers: {
      'Cache-Control': 'no-store',
      Vary: 'Authorization',
    },
  });
}
