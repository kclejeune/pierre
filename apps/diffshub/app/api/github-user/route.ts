import { type NextRequest } from 'next/server';

import {
  createGitHubAPIURL,
  createGitHubJSONHeaders,
  getGitHubEnvironment,
} from '@/lib/githubEnvironment';
import { createJSONResponse } from '@/lib/jsonResponse';
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
      headers: createGitHubJSONHeaders(token),
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
  });
}
