import { type NextRequest } from 'next/server';

import { fetchAssetFollowingRedirects } from '@/lib/assetRedirects';
import { createGitHubRawHeaders } from '@/lib/githubDiffFileServer';
import {
  getGitHubEnvironment,
  rejectTokenlessRequestWhenLoginRequired,
  resolveRequestGitHubToken,
} from '@/lib/githubEnvironment';
import {
  matchGitHubWebAsset,
  resolveGitHubWebAssetUpstreamURL,
} from '@/lib/githubWebAssets';
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
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }

  const environment = getGitHubEnvironment();
  const url = request.nextUrl.searchParams.get('url');
  const assetURL =
    url == null ? null : matchGitHubWebAsset(url, environment.webURL);
  if (assetURL == null) {
    return createJSONResponse(
      { error: 'url must be an asset on the configured GitHub instance.' },
      { status: 400 }
    );
  }

  let upstream: Response;
  try {
    upstream = await fetchAssetFollowingRedirects(
      resolveGitHubWebAssetUpstreamURL(assetURL, environment),
      createGitHubRawHeaders(resolveRequestGitHubToken(request))
    );
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

  // A 2xx carrying markup rather than an image means the instance answered
  // with a page (a login or error interstitial) where an asset was expected.
  // Rejecting it here keeps that from reaching the browser as a broken image.
  const contentType = upstream.headers.get('content-type') ?? '';
  if (!contentType.startsWith('image/')) {
    return createJSONResponse(
      {
        error: `Asset request returned ${contentType === '' ? 'no content type' : contentType}.`,
      },
      { status: 502 }
    );
  }

  return createInertAssetResponse(upstream);
}
