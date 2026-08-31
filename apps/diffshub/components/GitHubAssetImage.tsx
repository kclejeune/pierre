'use client';

import { type ImgHTMLAttributes, useEffect, useState } from 'react';

import { useGitHubEnvironment } from './GitHubEnvironmentProvider';
import { githubFetch } from './githubSession';
import { useGitHubTokenSnapshot } from './useGitHubToken';

// Object URLs keyed by token generation and proxy src so repeated renders
// share one authorized fetch without carrying private blobs across identities.
const objectURLBySrc = new Map<string, Promise<string>>();

// Drops cache entries from previous token generations and releases their
// object URLs — without this, every sign-in/sign-out cycle would orphan a
// full generation of blobs for the lifetime of the page.
function evictStaleGenerations(tokenVersion: number): void {
  for (const [key, stale] of objectURLBySrc) {
    if (!key.startsWith(`${tokenVersion}|`)) {
      objectURLBySrc.delete(key);
      void stale.then((url) => {
        if (url.startsWith('blob:')) {
          URL.revokeObjectURL(url);
        }
      });
    }
  }
}

// A data: URI that is not a decodable image: assigning it to <img src> fires
// the element's native error event without issuing a network request. Stands
// in for the plain proxy URL on require-login deployments, where the server
// rejects every tokenless request with 401, so requesting it would only spam
// the console before reaching the same onError.
const UNLOADABLE_ASSET_SRC = 'data:,';

function resolveAssetSrc(
  src: string,
  token: string,
  tokenVersion: number,
  requireLogin: boolean
): Promise<string> {
  if (token === '') {
    return Promise.resolve(requireLogin ? UNLOADABLE_ASSET_SRC : src);
  }
  const cacheKey = `${tokenVersion}|${src}`;
  let pending = objectURLBySrc.get(cacheKey);
  if (pending == null) {
    evictStaleGenerations(tokenVersion);
    pending = githubFetch(src, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Asset request failed: ${response.status}`);
        }
        return URL.createObjectURL(await response.blob());
      })
      .catch(() => {
        objectURLBySrc.delete(cacheKey);
        return requireLogin ? UNLOADABLE_ASSET_SRC : src;
      });
    objectURLBySrc.set(cacheKey, pending);
  }
  return pending;
}

// An image served through one of the same-origin GitHub asset proxies
// (/api/github-doc-asset, /api/github-web-asset). <img> requests cannot carry
// an Authorization header, so when the viewer has a saved GitHub token the
// asset is fetched with the header and shown from an object URL — private
// repos and GHES then load images with the viewer's own credentials. Without
// a saved token (or when the authorized fetch fails) the proxy URL is used
// directly, which serves public-repo assets on github.com anonymously; if
// that fails too, the native onError fires so callers can render a fallback.
// Require-login deployments skip the tokenless request entirely — the server
// 401s it unconditionally — and jump straight to onError.
export function GitHubAssetImage({
  src,
  alt,
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const { requireLogin } = useGitHubEnvironment();
  const { token, version: tokenVersion } = useGitHubTokenSnapshot();
  const [resolvedSrc, setResolvedSrc] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void resolveAssetSrc(src, token, tokenVersion, requireLogin).then(
      (resolved) => {
        if (!cancelled) {
          setResolvedSrc(resolved);
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [src, token, tokenVersion, requireLogin]);

  return <img {...rest} alt={alt ?? ''} loading="lazy" src={resolvedSrc} />;
}
