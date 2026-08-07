import { type NextRequest } from 'next/server';

import { loadGitHubDiffAssetResponse } from '@/lib/githubDiffFileServer';
import { rejectTokenlessRequestWhenLoginRequired } from '@/lib/githubEnvironment';
import { createInertAssetResponse } from '@/lib/inertAssetResponse';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseBearerToken } from '@/lib/parseBearerToken';

// Same-origin proxy for images referenced by rendered markdown documents.
// Relative references in a doc resolve to repository paths, which the browser
// cannot fetch from the raw host directly (private repos and GHES need auth
// that <img> requests cannot carry) — so the server fetches them at the
// diff's resolved ref. Signed-in viewers fetch through here with their own
// Bearer token (DocAssetImage adds the header); without one the server falls
// back to its fallback token so anonymous visitors still see doc images.
// The response headers below keep even a crafted file inert on this origin.

// Tokenless requests are served with the operator's fallback token, but this
// endpoint can reach any file at the diff's refs — not just what the diff
// shows. Restricting anonymous fetches to the image types a rendered doc
// embeds keeps the fallback token from becoming an arbitrary-file reader for
// unauthenticated visitors; signed-in viewers read with their own access.
const ANONYMOUS_IMAGE_FILE_PATTERN =
  /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;

export async function GET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }

  const params = request.nextUrl.searchParams;
  const path = params.get('path');
  const file = params.get('file');
  const side = params.get('side') === 'old' ? 'old' : 'new';
  if (path == null || file == null || !isSafeRepoPath(file)) {
    return createJSONResponse(
      { error: 'path and file parameters are required.' },
      { status: 400 }
    );
  }

  const token = parseBearerToken(request.headers.get('authorization'));
  if (token == null && !ANONYMOUS_IMAGE_FILE_PATTERN.test(file)) {
    return createJSONResponse(
      { error: 'Anonymous asset requests are limited to image files.' },
      { status: 401 }
    );
  }
  let upstream: Response;
  try {
    upstream = await loadGitHubDiffAssetResponse(
      { file, path, side },
      token == null ? {} : { token, tokenSource: 'request' }
    );
  } catch (error) {
    return createJSONResponse(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 502 }
    );
  }

  return createInertAssetResponse(upstream);
}

function isSafeRepoPath(file: string): boolean {
  return (
    file !== '' &&
    !file.startsWith('/') &&
    file
      .split('/')
      .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  );
}
