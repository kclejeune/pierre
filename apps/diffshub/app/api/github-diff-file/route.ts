import type { ChangeTypes } from '@pierre/diffs';
import { type NextRequest } from 'next/server';

import {
  GitHubDiffChangedError,
  loadGitHubDiffFiles,
} from '@/lib/githubDiffFileServer';
import { createJSONResponse } from '@/lib/jsonResponse';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';

const CHANGE_TYPES = new Set<ChangeTypes>([
  'change',
  'deleted',
  'new',
  'rename-changed',
  'rename-pure',
]);

async function handleGET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const path = params.get('path');
  const name = params.get('name');
  const type = parseChangeType(params.get('type'));
  const prevName = params.get('prevName') ?? undefined;
  const prevObjectId = params.get('prevObjectId') ?? undefined;
  const newObjectId = params.get('newObjectId') ?? undefined;
  const token = await resolveBearerToken(request);

  if (path == null || name == null || type == null) {
    return createJSONResponse(
      { error: 'path, name, and supported type parameters are required.' },
      { status: 400 }
    );
  }

  if (token == null) {
    return createJSONResponse(
      { error: 'GitHub file expansion requires a configured token.' },
      { status: 401 }
    );
  }

  try {
    return createJSONResponse(
      await loadGitHubDiffFiles(
        { name, newObjectId, path, prevName, prevObjectId, type },
        { token, tokenFromRequest: true }
      )
    );
  } catch (error) {
    return createJSONResponse(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: error instanceof GitHubDiffChangedError ? 409 : 502 }
    );
  }
}

function parseChangeType(value: string | null): ChangeTypes | undefined {
  if (value == null) {
    return undefined;
  }
  return CHANGE_TYPES.has(value as ChangeTypes)
    ? (value as ChangeTypes)
    : undefined;
}

export const GET = withRequestLog(handleGET);
