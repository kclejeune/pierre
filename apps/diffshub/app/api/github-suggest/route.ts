import { type NextRequest } from 'next/server';

import type { PullSearchHit } from '@/lib/diffUrlSuggestions';
import { repoPath } from '@/lib/githubCommitServer';
import { encodeURLSegment } from '@/lib/githubDiffSource';
import {
  createGitHubAPIURL,
  createGitHubJSONHeaders,
  getGitHubEnvironment,
  rejectTokenlessRequestWhenLoginRequired,
} from '@/lib/githubEnvironment';
import { githubFetch } from '@/lib/githubFetch';
import {
  createGitHubFailureResponse,
  createUnreachableResponse,
  readGitHubJSON,
} from '@/lib/githubProxyResponse';
import { restPullState } from '@/lib/githubPullDetailsServer';
import { buildPullTextSearch } from '@/lib/githubPullSummaries';
import {
  createJSONResponse,
  createPrivateJSONResponse,
} from '@/lib/jsonResponse';
import {
  isValidRepoName,
  MAX_PINNED_REPOS,
  splitRepoName,
} from '@/lib/pinnedRepos';
import { readPullNumberQuery } from '@/lib/pullSearchQuery';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';
import { asRecord } from '@/lib/untypedJson';

// Autocomplete data for the diff URL bar and command palette: repository
// name search while the user types "owner/rep…", a repository's open pull
// requests once one is selected, and pull request search by number or
// title. Each proxies the GitHub API with the viewer's token so the browser
// never talks to the instance cross-origin.

async function handleGET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }

  const params = request.nextUrl.searchParams;
  const kind = params.get('kind');
  const token = await resolveBearerToken(request);
  const environment = getGitHubEnvironment();

  if (kind === 'repos') {
    const query = params.get('q')?.trim() ?? '';
    const owner = params.get('owner')?.trim() ?? '';
    if (query === '' && owner === '') {
      return createPrivateJSONResponse({ repos: [] }, 60);
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
    return createPrivateJSONResponse(
      {
        repos: items
          .map((item) => item.full_name)
          .filter((name): name is string => typeof name === 'string'),
      },
      60
    );
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
    return createPrivateJSONResponse(
      {
        pulls: pulls
          .map((pull: { number?: unknown; title?: unknown }) => ({
            number: pull.number,
            title: pull.title,
          }))
          .filter(
            (pull): pull is { number: number; title: string } =>
              typeof pull.number === 'number' && typeof pull.title === 'string'
          ),
      },
      60
    );
  }

  if (kind === 'pull-search') {
    const query = params.get('q')?.trim() ?? '';
    // Comma-separated owner/name list to search within. Absent searches
    // every repository the token can see; empty searches nothing.
    const reposParam = params.get('repos');
    const repos = reposParam?.split(',').filter((repo) => repo !== '') ?? null;
    if (query === '' || repos?.length === 0) {
      return createPrivateJSONResponse({ pulls: [] }, 60);
    }
    // A repo name with spaces or other qualifiers in it would change the
    // search rather than scope it.
    if (repos != null && !repos.every(isValidRepoName)) {
      return createJSONResponse(
        { error: 'repos must be owner/name pairs.' },
        { status: 400 }
      );
    }
    // A number in named repositories is looked up directly: text search
    // can rank pulls that merely mention it above the pull itself, and the
    // lookups don't spend the search API's ~30 requests a minute.
    const number = readPullNumberQuery(query);
    if (number != null && repos != null && repos.length <= MAX_NUMBER_LOOKUPS) {
      const lookups = await Promise.all(
        repos.map((repo) =>
          lookUpPull(environment, token, repo, number, request.signal)
        )
      );
      // A rejected token (or GitHub being down) answers as itself, so the
      // client's credential recovery sees the 401 rather than a cached miss.
      const failure = lookups.find((lookup) => lookup.error != null)?.error;
      return (
        failure ??
        createPrivateJSONResponse(
          { pulls: lookups.flatMap((lookup) => lookup.hits) },
          60
        )
      );
    }
    const result = await fetchSuggestPayload(
      // Advanced search, as the dashboard's ISSUE_ADVANCED search uses:
      // legacy syntax rejects the grouped "(repo:a OR repo:b)" scope.
      createGitHubAPIURL(environment, '/search/issues', {
        advanced_search: 'true',
        per_page: '8',
        q: buildPullTextSearch(query, repos ?? []),
      }),
      token,
      { signal: request.signal }
    );
    if (result.error != null) {
      return result.error;
    }
    const items = (result.payload as { items?: unknown[] }).items ?? [];
    return createPrivateJSONResponse(
      { pulls: items.flatMap(readPullSearchHit) },
      60
    );
  }

  return createJSONResponse(
    { error: 'kind must be repos, pulls, or pull-search.' },
    { status: 400 }
  );
}

// How many repositories a pull number is looked up in one by one (the
// pinned scope's most); more fall back to text search.
const MAX_NUMBER_LOOKUPS = MAX_PINNED_REPOS;

// Pull request `number` of `repo` as a palette row: none when the
// repository has no such pull, or GitHub's failure response otherwise.
async function lookUpPull(
  environment: ReturnType<typeof getGitHubEnvironment>,
  token: string | undefined,
  repo: string,
  number: string,
  signal: AbortSignal
): Promise<{ hits: PullSearchHit[]; error?: Response }> {
  const result = await fetchSuggestPayload(
    createGitHubAPIURL(
      environment,
      repoPath(splitRepoName(repo), `/pulls/${encodeURLSegment(number)}`)
    ),
    token,
    { missing: 'empty', signal }
  );
  if (result.error != null) {
    return { error: result.error, hits: [] };
  }
  const pull = asRecord(result.payload);
  return { hits: pull == null ? [] : toPullHit(pull, repo, pull.merged_at) };
}

// One /search/issues hit as the palette's pull row, or nothing when it
// isn't a well-formed pull request. The repository comes from the hit's
// repository_url (".../repos/owner/name").
function readPullSearchHit(item: unknown): PullSearchHit[] {
  const hit = asRecord(item);
  const pullRequest = asRecord(hit?.pull_request);
  const repo =
    typeof hit?.repository_url === 'string'
      ? /\/repos\/([^/]+\/[^/]+)$/.exec(hit.repository_url)?.[1]
      : undefined;
  return hit == null || pullRequest == null || repo == null
    ? []
    : toPullHit(hit, repo, pullRequest.merged_at);
}

// A pull (a REST pull or a search hit) as the palette's row, or nothing
// without a number and title.
function toPullHit(
  record: Record<string, unknown>,
  repo: string,
  mergedAt: unknown
): PullSearchHit[] {
  if (typeof record.number !== 'number' || typeof record.title !== 'string') {
    return [];
  }
  return [
    {
      number: record.number,
      repo,
      state: restPullState(record.state, mergedAt),
      title: record.title,
    },
  ];
}

// `signal` (the client's request) lets a superseded search stop its
// upstream work, so it stops holding the token's GitHub request slots.
// `missing: 'empty'` reads a 404 as an empty payload (a lookup's ordinary
// miss) rather than an upstream failure.
async function fetchSuggestPayload(
  url: string,
  token: string | undefined,
  options: { missing?: 'empty'; signal?: AbortSignal } = {}
): Promise<{ payload?: unknown; error?: Response }> {
  let response: Response;
  try {
    response = await githubFetch(url, {
      headers: createGitHubJSONHeaders(token),
      cache: 'no-store',
      signal: options.signal,
    });
  } catch {
    // A superseded search the client already dropped isn't GitHub being
    // unreachable; answer quietly instead of logging an upstream failure.
    if (options.signal?.aborted === true) {
      return {
        error: createJSONResponse(
          { error: 'The request was cancelled.' },
          { status: 499 }
        ),
      };
    }
    return {
      error: createUnreachableResponse(getGitHubEnvironment(), url),
    };
  }
  if (response.status === 404 && options.missing === 'empty') {
    return {};
  }
  if (!response.ok) {
    return {
      error: await createGitHubFailureResponse(response),
    };
  }
  const parsed = await readGitHubJSON(response);
  return parsed.failure != null
    ? { error: parsed.failure }
    : { payload: parsed.data };
}

export const GET = withRequestLog(handleGET);
