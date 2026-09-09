import { type NextRequest } from 'next/server';

import { rejectTokenlessRequestWhenLoginRequired } from '@/lib/githubEnvironment';
import {
  readRepoParams,
  repoBrowserErrorResponse,
} from '@/lib/githubRepoBrowserServer';
import { loadRepoRefs } from '@/lib/githubRepoRefsServer';
import { createPrivateJSONResponse } from '@/lib/jsonResponse';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';

// Lists a repository's default branch, branches, and tags for the /browse
// dashboard's ref picker.
async function handleGET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }

  const repo = readRepoParams(request.nextUrl.searchParams);
  if (repo instanceof Response) {
    return repo;
  }

  try {
    return createPrivateJSONResponse(
      await loadRepoRefs(repo, {
        token: await resolveBearerToken(request),
      }),
      60
    );
  } catch (error) {
    return repoBrowserErrorResponse(error);
  }
}

export const GET = withRequestLog(handleGET);
