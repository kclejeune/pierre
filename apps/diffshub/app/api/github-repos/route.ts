import { type NextRequest } from 'next/server';

import {
  createGitHubAPIURL,
  createGitHubJSONHeaders,
  getGitHubEnvironment,
  type GitHubEnvironment,
} from '@/lib/githubEnvironment';
import {
  createGitHubFailureResponse,
  createUnreachableResponse,
  readGitHubJSON,
} from '@/lib/githubProxyResponse';
import { createJSONResponse } from '@/lib/jsonResponse';
import {
  parseRepoDirectoryOwner,
  parseRepoDirectoryRepo,
  type RepoDirectoryOwner,
  type RepoDirectoryPayload,
  type RepoDirectoryRepo,
} from '@/lib/repoDirectory';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';

// Load a useful first directory in two waves. Accounts beyond this initial
// slice receive a continuation cursor and can fetch further pages on demand.
const MAX_REPO_PAGES = 3;
const REPO_PAGE_SIZE = 100;

function fetchRepoPage(
  environment: GitHubEnvironment,
  token: string,
  page: number
): Promise<Response> {
  return fetch(
    createGitHubAPIURL(environment, '/user/repos', {
      affiliation: 'owner,collaborator,organization_member',
      page: String(page),
      per_page: String(REPO_PAGE_SIZE),
      sort: 'pushed',
    }),
    { cache: 'no-store', headers: createGitHubJSONHeaders(token) }
  );
}

// The viewer's repository directory for the browse/pulls dashboards: the
// organizations they belong to and every repository they own, collaborate
// on, or can reach through an org, most recently pushed first. Requires a
// token — GitHub has no anonymous notion of "your repositories".
async function handleGET(request: NextRequest) {
  const token = await resolveBearerToken(request);
  if (token == null) {
    return createJSONResponse(
      { error: 'Listing your repositories requires signing in.' },
      { status: 401 }
    );
  }
  const environment = getGitHubEnvironment();
  const requestedPage = request.nextUrl.searchParams.get('page');
  if (requestedPage != null) {
    const page = Number(requestedPage);
    if (
      !/^\d+$/.test(requestedPage) ||
      !Number.isSafeInteger(page) ||
      page < 2
    ) {
      return createJSONResponse(
        { error: 'page must be an integer greater than one.' },
        { status: 400 }
      );
    }
    try {
      const response = await fetchRepoPage(environment, token, page);
      if (!response.ok) {
        return await createGitHubFailureResponse(response);
      }
      const parsed = await readGitHubJSON(response);
      if (parsed.failure != null) {
        return parsed.failure;
      }
      const pagePayload = parsed.data;
      const { owners, repos } = parseRepoPages([pagePayload]);
      const payload: RepoDirectoryPayload = {
        orgs: [],
        nextPage:
          Array.isArray(pagePayload) && pagePayload.length === REPO_PAGE_SIZE
            ? page + 1
            : undefined,
        repoOwners: [...owners.values()],
        repos,
        viewer: null,
      };
      return createJSONResponse(payload);
    } catch {
      return createUnreachableResponse(environment);
    }
  }

  try {
    // The first repos page rides in the same round-trip wave as the viewer
    // and org listings; only accounts past one page need a second wave.
    const [viewerResponse, orgsResponse, firstRepoPage] = await Promise.all([
      fetch(createGitHubAPIURL(environment, '/user'), {
        cache: 'no-store',
        headers: createGitHubJSONHeaders(token),
      }),
      fetch(
        createGitHubAPIURL(environment, '/user/orgs', { per_page: '100' }),
        { cache: 'no-store', headers: createGitHubJSONHeaders(token) }
      ),
      fetchRepoPage(environment, token, 1),
    ]);
    if (!viewerResponse.ok) {
      return await createGitHubFailureResponse(viewerResponse);
    }
    const parsedViewer = await readGitHubJSON(viewerResponse);
    if (parsedViewer.failure != null) {
      return parsedViewer.failure;
    }
    const viewer = parseRepoDirectoryOwner(parsedViewer.data, 'user');
    // Org membership can be hidden from some tokens; the directory still
    // works grouped by the owners present in the repo listing.
    const orgs: RepoDirectoryOwner[] = [];
    if (orgsResponse.ok) {
      // Best-effort, so a body that will not parse is treated the same as a
      // hidden org list rather than failing the whole directory.
      const orgsPayload = (await readGitHubJSON(orgsResponse)).data;
      if (Array.isArray(orgsPayload)) {
        for (const org of orgsPayload) {
          const owner = parseRepoDirectoryOwner(org, 'org');
          if (owner != null) {
            orgs.push(owner);
          }
        }
      }
    }

    if (!firstRepoPage.ok) {
      return await createGitHubFailureResponse(firstRepoPage);
    }
    const parsedFirstPage = await readGitHubJSON(firstRepoPage);
    if (parsedFirstPage.failure != null) {
      return parsedFirstPage.failure;
    }
    const firstPagePayload = parsedFirstPage.data;
    const repoPages: unknown[] = [firstPagePayload];
    if (
      Array.isArray(firstPagePayload) &&
      firstPagePayload.length === REPO_PAGE_SIZE
    ) {
      const restResponses = await Promise.all(
        Array.from({ length: MAX_REPO_PAGES - 1 }, (_, index) =>
          fetchRepoPage(environment, token, index + 2)
        )
      );
      for (const response of restResponses) {
        if (!response.ok) {
          return await createGitHubFailureResponse(response);
        }
        const parsedPage = await readGitHubJSON(response);
        if (parsedPage.failure != null) {
          return parsedPage.failure;
        }
        const pagePayload = parsedPage.data;
        repoPages.push(pagePayload);
        if (
          !Array.isArray(pagePayload) ||
          pagePayload.length < REPO_PAGE_SIZE
        ) {
          break;
        }
      }
    }

    const { owners, repos } = parseRepoPages(repoPages);
    const lastPage = repoPages.at(-1);

    const payload: RepoDirectoryPayload = {
      orgs,
      nextPage:
        repoPages.length === MAX_REPO_PAGES &&
        Array.isArray(lastPage) &&
        lastPage.length === REPO_PAGE_SIZE
          ? MAX_REPO_PAGES + 1
          : undefined,
      // Owners seen only through the repo listing (e.g. a collaborator
      // repo's owner), so the client can label and avatar every group.
      repoOwners: [...owners.values()],
      repos,
      viewer,
    };
    return createJSONResponse(payload);
  } catch {
    return createUnreachableResponse(environment);
  }
}

function parseRepoPages(pagePayloads: readonly unknown[]) {
  const repos: RepoDirectoryRepo[] = [];
  const owners = new Map<string, RepoDirectoryOwner>();
  for (const pagePayload of pagePayloads) {
    if (!Array.isArray(pagePayload)) {
      continue;
    }
    for (const item of pagePayload) {
      const repo = parseRepoDirectoryRepo(item);
      if (repo != null) {
        repos.push(repo.repo);
        if (!owners.has(repo.owner.login)) {
          owners.set(repo.owner.login, repo.owner);
        }
      }
    }
  }
  return { owners, repos };
}

export const GET = withRequestLog(handleGET);
