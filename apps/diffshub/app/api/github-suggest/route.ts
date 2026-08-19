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

// Autocomplete data for the diff URL bar: repository name search while the
// user types "owner/rep…", and the open pull requests of a repo once one is
// selected. Both proxy the GitHub API with the viewer's token so the browser
// never talks to the instance cross-origin.

export async function GET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }

  const params = request.nextUrl.searchParams;
  const kind = params.get('kind');
  const token = parseBearerToken(request.headers.get('authorization'));
  const environment = getGitHubEnvironment();

  if (kind === 'repos') {
    const query = params.get('q')?.trim() ?? '';
    const owner = params.get('owner')?.trim() ?? '';
    if (query === '' && owner === '') {
      return createJSONResponse({ repos: [] });
    }
    // Scope to the owner once one is typed; plain-name search otherwise. An
    // owner with no name query lists their recently-updated repos.
    const search =
      owner === ''
        ? `${query} in:name`
        : `${query === '' ? '' : `${query} in:name `}user:${owner}`;
    const searchParams: Record<string, string> = { per_page: '8', q: search };
    if (query === '') {
      searchParams.sort = 'updated';
    }
    const result = await fetchSuggestPayload(
      createGitHubAPIURL(environment, '/search/repositories', searchParams),
      token
    );
    if (result.error != null) {
      return result.error;
    }
    const items =
      (result.payload as { items?: { full_name?: unknown }[] }).items ?? [];
    return createJSONResponse({
      repos: items
        .map((item) => item.full_name)
        .filter((name): name is string => typeof name === 'string'),
    });
  }

  if (kind === 'pulls') {
    const owner = params.get('owner');
    const repo = params.get('repo');
    if (owner == null || repo == null) {
      return createJSONResponse(
        { error: 'owner and repo are required.' },
        { status: 400 }
      );
    }
    const result = await fetchSuggestPayload(
      createGitHubAPIURL(
        environment,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
        { per_page: '30', state: 'open' }
      ),
      token
    );
    if (result.error != null) {
      return result.error;
    }
    const pulls = Array.isArray(result.payload) ? result.payload : [];
    return createJSONResponse({
      pulls: pulls
        .map((pull: { number?: unknown; title?: unknown }) => ({
          number: pull.number,
          title: pull.title,
        }))
        .filter(
          (pull): pull is { number: number; title: string } =>
            typeof pull.number === 'number' && typeof pull.title === 'string'
        ),
    });
  }

  return createJSONResponse(
    { error: 'kind must be repos or pulls.' },
    { status: 400 }
  );
}

async function fetchSuggestPayload(
  url: string,
  token: string | undefined
): Promise<{ payload?: unknown; error?: Response }> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: createGitHubJSONHeaders(token),
      cache: 'no-store',
    });
  } catch {
    return { error: createUnreachableResponse(getGitHubEnvironment()) };
  }
  if (!response.ok) {
    return { error: await createGitHubFailureResponse(response) };
  }
  return { payload: await response.json() };
}
