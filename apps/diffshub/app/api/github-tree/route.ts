import { type NextRequest } from 'next/server';

import { rejectTokenlessRequestWhenLoginRequired } from '@/lib/githubEnvironment';
import {
  loadRepoBrowserTree,
  readRepoParams,
  repoBrowserErrorResponse,
} from '@/lib/githubRepoBrowserServer';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseBearerToken } from '@/lib/parseBearerToken';

// Lists a repository's file tree for the browse view: resolves the `ref`
// remainder (branch, tag, sha, or refs/pull/… plus an optional sub-path)
// against the repo and returns every blob path at the resolved commit.
export async function GET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }

  const repo = readRepoParams(request.nextUrl.searchParams);
  if (repo instanceof Response) {
    return repo;
  }
  const ref = request.nextUrl.searchParams.get('ref') ?? '';

  try {
    return createJSONResponse(
      await loadRepoBrowserTree(repo, ref, {
        token: parseBearerToken(request.headers.get('authorization')),
      })
    );
  } catch (error) {
    return repoBrowserErrorResponse(error);
  }
}
