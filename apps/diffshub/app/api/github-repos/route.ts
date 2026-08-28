import { type NextRequest } from 'next/server';

import {
  createGitHubAPIURL,
  createGitHubJSONHeaders,
  getGitHubEnvironment,
} from '@/lib/githubEnvironment';
import {
  createGitHubFailureResponse,
  createUnreachableResponse,
} from '@/lib/githubProxyResponse';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseBearerToken } from '@/lib/parseBearerToken';
import type {
  RepoDirectoryOwner,
  RepoDirectoryPayload,
  RepoDirectoryRepo,
} from '@/lib/repoDirectory';

// How many pages of /user/repos to walk (100 per page). Enough for the
// dashboards' directory; heavier accounts fall back to the search box.
const MAX_REPO_PAGES = 3;

// The viewer's repository directory for the browse/pulls dashboards: the
// organizations they belong to and every repository they own, collaborate
// on, or can reach through an org, most recently pushed first. Requires a
// token — GitHub has no anonymous notion of "your repositories".
export async function GET(request: NextRequest) {
  const token = parseBearerToken(request.headers.get('authorization'));
  if (token == null) {
    return createJSONResponse(
      { error: 'Listing your repositories requires signing in.' },
      { status: 401 }
    );
  }
  const environment = getGitHubEnvironment();

  try {
    const [viewerResponse, orgsResponse] = await Promise.all([
      fetch(createGitHubAPIURL(environment, '/user'), {
        cache: 'no-store',
        headers: createGitHubJSONHeaders(token),
      }),
      fetch(
        createGitHubAPIURL(environment, '/user/orgs', { per_page: '100' }),
        { cache: 'no-store', headers: createGitHubJSONHeaders(token) }
      ),
    ]);
    if (!viewerResponse.ok) {
      return await createGitHubFailureResponse(viewerResponse);
    }
    const viewer = parseOwner(await viewerResponse.json(), 'user');
    // Org membership can be hidden from some tokens; the directory still
    // works grouped by the owners present in the repo listing.
    const orgs: RepoDirectoryOwner[] = [];
    if (orgsResponse.ok) {
      const orgsPayload: unknown = await orgsResponse.json();
      if (Array.isArray(orgsPayload)) {
        for (const org of orgsPayload) {
          const owner = parseOwner(org, 'org');
          if (owner != null) {
            orgs.push(owner);
          }
        }
      }
    }

    const repos: RepoDirectoryRepo[] = [];
    const owners = new Map<string, RepoDirectoryOwner>();
    for (let page = 1; page <= MAX_REPO_PAGES; page += 1) {
      const response = await fetch(
        createGitHubAPIURL(environment, '/user/repos', {
          affiliation: 'owner,collaborator,organization_member',
          page: String(page),
          per_page: '100',
          sort: 'pushed',
        }),
        { cache: 'no-store', headers: createGitHubJSONHeaders(token) }
      );
      if (!response.ok) {
        return await createGitHubFailureResponse(response);
      }
      const pagePayload: unknown = await response.json();
      if (!Array.isArray(pagePayload)) {
        break;
      }
      for (const item of pagePayload) {
        const repo = parseRepo(item);
        if (repo != null) {
          repos.push(repo.repo);
          if (!owners.has(repo.owner.login)) {
            owners.set(repo.owner.login, repo.owner);
          }
        }
      }
      if (pagePayload.length < 100) {
        break;
      }
    }

    const payload: RepoDirectoryPayload = {
      orgs,
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value != null
    ? (value as Record<string, unknown>)
    : null;
}

function parseOwner(
  value: unknown,
  fallbackKind: 'org' | 'user'
): RepoDirectoryOwner | null {
  const record = asRecord(value);
  const login = record?.login;
  if (typeof login !== 'string' || login === '') {
    return null;
  }
  return {
    avatarUrl:
      typeof record?.avatar_url === 'string' ? record.avatar_url : undefined,
    kind: record?.type === 'Organization' ? 'org' : fallbackKind,
    login,
  };
}

function parseRepo(
  value: unknown
): { owner: RepoDirectoryOwner; repo: RepoDirectoryRepo } | null {
  const record = asRecord(value);
  const name = record?.name;
  const owner = parseOwner(record?.owner, 'user');
  if (typeof name !== 'string' || name === '' || owner == null) {
    return null;
  }
  return {
    owner,
    repo: {
      archived: record?.archived === true,
      fullName: `${owner.login}/${name}`,
      name,
      owner: owner.login,
      private: record?.private === true,
      pushedAt:
        typeof record?.pushed_at === 'string' ? record.pushed_at : undefined,
    },
  };
}
