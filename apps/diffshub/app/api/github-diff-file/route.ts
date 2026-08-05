import type { ChangeTypes } from '@pierre/diffs';
import { type NextRequest } from 'next/server';

import { loadGitHubDiffFiles } from '@/lib/githubDiffFileServer';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseBearerToken } from '@/lib/parseBearerToken';

const CHANGE_TYPES = new Set<ChangeTypes>([
  'change',
  'deleted',
  'new',
  'rename-changed',
  'rename-pure',
]);

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const path = params.get('path');
  const name = params.get('name');
  const type = parseChangeType(params.get('type'));
  const prevName = params.get('prevName') ?? undefined;
  const token = parseBearerToken(request.headers.get('authorization'));

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
        { name, path, prevName, type },
        { token, tokenSource: 'request' }
      )
    );
  } catch (error) {
    return createJSONResponse(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 502 }
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
