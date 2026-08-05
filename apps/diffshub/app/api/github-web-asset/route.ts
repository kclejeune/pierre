import { type NextRequest } from 'next/server';

import { createGitHubRawHeaders } from '@/lib/githubDiffFileServer';
import {
  getGitHubEnvironment,
  resolveRequestGitHubToken,
} from '@/lib/githubEnvironment';
import { matchGitHubWebAsset } from '@/lib/githubWebAssets';
import { createInertAssetResponse } from '@/lib/inertAssetResponse';
import { createJSONResponse } from '@/lib/jsonResponse';

// Same-origin proxy for assets the GitHub instance serves outside the repo
// tree: comment-author avatars and pasted user-attachment images. On a
// private-mode GHES these routes require auth that cross-origin <img>
// requests cannot carry, so the browser fetches them through here with the
// viewer's Bearer token (falling back to the server token for anonymous
// visitors). Only allow-listed paths on the configured instance are fetched —
// this must not become an open proxy.

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url');
  const assetURL =
    url == null
      ? null
      : matchGitHubWebAsset(url, getGitHubEnvironment().webURL);
  if (assetURL == null) {
    return createJSONResponse(
      { error: 'url must be an asset on the configured GitHub instance.' },
      { status: 400 }
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(assetURL, {
      headers: createGitHubRawHeaders(resolveRequestGitHubToken(request)),
      redirect: 'follow',
    });
  } catch (error) {
    return createJSONResponse(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 502 }
    );
  }
  if (!upstream.ok) {
    return createJSONResponse(
      { error: `Asset request failed (${upstream.status}).` },
      { status: 502 }
    );
  }

  return createInertAssetResponse(upstream);
}
