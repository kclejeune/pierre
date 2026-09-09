import { type NextRequest } from 'next/server';

import { isFullCommitSha } from '@/lib/githubDiffSource';
import { rejectTokenlessRequestWhenLoginRequired } from '@/lib/githubEnvironment';
import {
  loadRepoBrowserTree,
  readRepoParams,
  repoBrowserErrorResponse,
} from '@/lib/githubRepoBrowserServer';
import { createPrivateJSONResponse } from '@/lib/jsonResponse';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';

// A tree pinned to a commit sha can never change, so it is cached for a year;
// a branch or tag moves, so it gets a short revalidation window instead.
const IMMUTABLE_TREE_MAX_AGE_SECONDS = 31_536_000;
const MOVING_REF_TREE_MAX_AGE_SECONDS = 60;

// Lists a repository's file tree for the browse view: resolves the `ref`
// remainder (branch, tag, sha, or refs/pull/… plus an optional sub-path)
// against the repo and returns every blob path at the resolved commit.
async function handleGET(request: NextRequest) {
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
    const payload = await loadRepoBrowserTree(repo, ref, {
      token: await resolveBearerToken(request),
    });
    const immutable = isFullCommitSha(ref.split('/', 1)[0] ?? '');
    return createPrivateJSONResponse(
      payload,
      immutable
        ? IMMUTABLE_TREE_MAX_AGE_SECONDS
        : MOVING_REF_TREE_MAX_AGE_SECONDS,
      { immutable }
    );
  } catch (error) {
    return repoBrowserErrorResponse(error);
  }
}

export const GET = withRequestLog(handleGET);
