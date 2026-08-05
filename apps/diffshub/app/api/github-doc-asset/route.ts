import { type NextRequest } from 'next/server';

import { loadGitHubDiffAssetResponse } from '@/lib/githubDiffFileServer';
import { createJSONResponse } from '@/lib/jsonResponse';

// Same-origin proxy for images referenced by rendered markdown documents.
// Relative references in a doc resolve to repository paths, which the browser
// cannot fetch from the raw host directly (private repos and GHES need auth
// that <img> requests cannot carry) — so the server fetches them at the
// diff's resolved ref using its fallback token. This grants anonymous
// visitors the same read access the fallback token already provides through
// diff loading and comment reads; the response headers below keep even a
// crafted file inert on this origin.

export async function GET(request: NextRequest) {
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

  let upstream: Response;
  try {
    upstream = await loadGitHubDiffAssetResponse({ file, path, side });
  } catch (error) {
    return createJSONResponse(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 502 }
    );
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type':
        upstream.headers.get('content-type') ?? 'application/octet-stream',
      // The refs behind a diff can move (the server re-resolves them every
      // few minutes), so keep browser caching short.
      'Cache-Control': 'private, max-age=300',
      // Mirror raw.githubusercontent.com's defenses so a crafted SVG opened
      // directly cannot run scripts on this origin.
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    },
  });
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
