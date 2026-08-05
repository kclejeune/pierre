import { type NextRequest } from 'next/server';

import {
  getFallbackGitHubToken,
  getGitHubEnvironment,
  GITHUB_USER_AGENT,
} from '@/lib/githubEnvironment';
import { matchGitHubWebAsset } from '@/lib/githubWebAssets';
import { createJSONResponse } from '@/lib/jsonResponse';
import { parseBearerToken } from '@/lib/parseBearerToken';

// Same-origin proxy for assets the GitHub instance serves outside the repo
// tree: comment-author avatars and pasted user-attachment images. On a
// private-mode GHES these routes require auth that cross-origin <img>
// requests cannot carry, so the browser fetches them through here with the
// viewer's Bearer token (falling back to the server token for anonymous
// visitors). Only allow-listed paths on the configured instance are fetched —
// this must not become an open proxy. The response headers mirror the
// doc-asset route so a crafted file stays inert on this origin.

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

  const token =
    parseBearerToken(request.headers.get('authorization')) ??
    getFallbackGitHubToken();
  const headers: Record<string, string> = { 'User-Agent': GITHUB_USER_AGENT };
  if (token != null && token !== '') {
    headers.Authorization = `Bearer ${token}`;
  }

  let upstream: Response;
  try {
    upstream = await fetch(assetURL, { headers, redirect: 'follow' });
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

  return new Response(upstream.body, {
    headers: {
      'Content-Type':
        upstream.headers.get('content-type') ?? 'application/octet-stream',
      'Cache-Control': 'private, max-age=300',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
