import { type NextRequest } from 'next/server';

import { fetchAssetFollowingRedirects } from '@/lib/assetRedirects';
import {
  noteAvatarCredentialRefused,
  resolveAvatarCredential,
} from '@/lib/avatarCredential';
import { createGitHubRawHeaders } from '@/lib/githubDiffFileServer';
import {
  getGitHubEnvironment,
  rejectTokenlessRequestWhenLoginRequired,
} from '@/lib/githubEnvironment';
import {
  matchGitHubWebAsset,
  resolveGitHubWebAssetUpstreamURL,
} from '@/lib/githubWebAssets';
import { createInertAssetResponse } from '@/lib/inertAssetResponse';
import { createJSONResponse } from '@/lib/jsonResponse';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';
import {
  formatError,
  logUpstreamFailure,
  type UpstreamCredential,
  type UpstreamFailure,
} from '@/lib/serverLog';

// Same-origin proxy for assets the GitHub instance serves outside the repo
// tree: comment-author avatars and pasted user-attachment images. On a
// private-mode GHES these routes require auth that cross-origin <img>
// requests cannot carry, so the browser fetches them through here with the
// viewer's Bearer token. Only allow-listed paths on the configured instance
// are fetched — this must not become an open proxy.
//
// Avatar lookups are the one exception to "always the viewer's token" — see
// lib/avatarCredential.

const ROUTE = 'github-web-asset';

async function handleGET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }

  const environment = getGitHubEnvironment();
  const url = request.nextUrl.searchParams.get('url');
  const avatarLogin = request.nextUrl.searchParams.get('login') ?? undefined;
  const assetURL =
    url == null ? null : matchGitHubWebAsset(url, environment.webURL);
  if (assetURL == null) {
    return createJSONResponse(
      { error: 'url must be an asset on the configured GitHub instance.' },
      { status: 400 }
    );
  }

  const asset = resolveGitHubWebAssetUpstreamURL(
    assetURL,
    environment,
    avatarLogin
  );
  // Every failure in this handler concerns the same upstream request, so only
  // the credential and the outcome vary between log lines.
  const logFailure = (
    outcome: Omit<UpstreamFailure, 'route' | 'upstreamURL'>
  ) => {
    logUpstreamFailure({ ...outcome, route: ROUTE, upstreamURL: asset.url });
  };

  let upstream: Response;
  let credential: UpstreamCredential = 'none';
  try {
    const viewerToken = await resolveBearerToken(request);
    const avatarToken = asset.isAvatarLookup
      ? resolveAvatarCredential(viewerToken)
      : undefined;
    credential = describeCredential(avatarToken, viewerToken);
    upstream = await fetchAsset(asset.url, avatarToken ?? viewerToken);
    // A refused deployment credential (mistyped, expired, revoked) must not
    // take avatars down where the viewer's own token would have served them.
    if (!upstream.ok && avatarToken != null) {
      logFailure({ credential, response: upstream });
      noteAvatarCredentialRefused();
      // Not awaited: cancelling an upstream body does not settle until its
      // connection drains, as in fetchAssetFollowingRedirects.
      void upstream.body?.cancel();
      credential = describeCredential(undefined, viewerToken);
      upstream = await fetchAsset(asset.url, viewerToken);
    }
  } catch (error) {
    logFailure({ credential, error });
    return createJSONResponse({ error: formatError(error) }, { status: 502 });
  }
  if (!upstream.ok) {
    logFailure({ credential, response: upstream });
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
    logFailure({ credential, response: upstream });
    return createJSONResponse(
      {
        error: `Asset request returned ${contentType === '' ? 'no content type' : contentType}.`,
      },
      { status: 502 }
    );
  }

  return createInertAssetResponse(upstream);
}

function fetchAsset(url: string, token: string | undefined): Promise<Response> {
  return fetchAssetFollowingRedirects(url, createGitHubRawHeaders(token));
}

function describeCredential(
  avatarToken: string | undefined,
  viewerToken: string | undefined
): UpstreamCredential {
  if (avatarToken != null) {
    return 'deployment-avatar';
  }
  return viewerToken == null ? 'none' : 'viewer';
}

export const GET = withRequestLog(handleGET);
