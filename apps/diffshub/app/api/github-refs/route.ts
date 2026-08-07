import { type NextRequest } from 'next/server';

import {
  rejectTokenlessRequestWhenLoginRequired,
  resolveRequestGitHubToken,
} from '@/lib/githubEnvironment';
import {
  readRepoParams,
  repoBrowserErrorResponse,
} from '@/lib/githubRepoBrowserServer';
import { loadRepoRefs } from '@/lib/githubRepoRefsServer';
import { createJSONResponse } from '@/lib/jsonResponse';

// Lists a repository's default branch, branches, and tags for the /browse
// dashboard's ref picker.
export async function GET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }

  const repo = readRepoParams(request.nextUrl.searchParams);
  if (repo instanceof Response) {
    return repo;
  }

  try {
    return createJSONResponse(
      await loadRepoRefs(repo, { token: resolveRequestGitHubToken(request) })
    );
  } catch (error) {
    return repoBrowserErrorResponse(error);
  }
}
