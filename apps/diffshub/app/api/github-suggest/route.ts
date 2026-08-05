import { type NextRequest } from 'next/server';

import {
  createGitHubAPIURL,
  createGitHubJSONHeaders,
  getFallbackGitHubToken,
  getGitHubEnvironment,
} from '@/lib/githubEnvironment';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseBearerToken } from '@/lib/parseBearerToken';

// Autocomplete data for the diff URL bar: repository name search while the
// user types "owner/rep…", and the open pull requests of a repo once one is
// selected. Both proxy the GitHub API with the viewer's token (fallback token
// otherwise) so the browser never talks to the instance cross-origin.

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const kind = params.get('kind');
  const token =
    parseBearerToken(request.headers.get('authorization')) ??
    getFallbackGitHubToken();
  const environment = getGitHubEnvironment();

  let url: string | null = null;
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
    url = createGitHubAPIURL(environment, '/search/repositories', searchParams);
  } else if (kind === 'pulls') {
    const owner = params.get('owner');
    const repo = params.get('repo');
    if (owner == null || repo == null) {
      return createJSONResponse(
        { error: 'owner and repo are required.' },
        { status: 400 }
      );
    }
    url = createGitHubAPIURL(
      environment,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      { per_page: '30', state: 'open' }
    );
  }
  if (url == null) {
    return createJSONResponse(
      { error: 'kind must be repos or pulls.' },
      { status: 400 }
    );
  }

  let response: Response;
  try {
    response = await fetch(url, {
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
      { status: 502 }
    );
  }

  const payload = (await response.json()) as unknown;
  if (kind === 'repos') {
    const items =
      (payload as { items?: { full_name?: unknown }[] }).items ?? [];
    return createJSONResponse({
      repos: items
        .map((item) => item.full_name)
        .filter((name): name is string => typeof name === 'string'),
    });
  }
  const pulls = Array.isArray(payload) ? payload : [];
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
