import { type NextRequest } from 'next/server';

import { rejectTokenlessRequestWhenLoginRequired } from '@/lib/githubEnvironment';
import {
  loadRepoBrowserFile,
  repoBrowserErrorResponse,
} from '@/lib/githubRepoBrowserServer';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseBearerToken } from '@/lib/parseBearerToken';

// Fetches one file's contents for the browse view, at the commit sha the
// tree listing resolved (so contents always match the listing).
export async function GET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }

  const params = request.nextUrl.searchParams;
  const owner = params.get('owner');
  const repo = params.get('repo');
  const ref = params.get('ref');
  const file = params.get('file');
  if (
    owner == null ||
    owner === '' ||
    repo == null ||
    repo === '' ||
    ref == null ||
    ref === '' ||
    file == null ||
    file === ''
  ) {
    return createJSONResponse(
      { error: 'owner, repo, ref, and file parameters are required.' },
      { status: 400 }
    );
  }

  try {
    const payload = await loadRepoBrowserFile({ owner, repo }, ref, file, {
      token: parseBearerToken(request.headers.get('authorization')),
    });
    // The tree listing pins `ref` to a commit sha, so the contents can never
    // change — let the browser cache them for as long as it likes.
    return createJSONResponse(payload, {
      headers: { 'Cache-Control': 'private, max-age=31536000, immutable' },
    });
  } catch (error) {
    return repoBrowserErrorResponse(error);
  }
}
