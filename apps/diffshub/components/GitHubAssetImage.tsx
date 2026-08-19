'use client';

import { type ImgHTMLAttributes, useEffect, useState } from 'react';

import { useGitHubEnvironment } from './GitHubEnvironmentProvider';
import { readStoredGitHubToken } from './useGitHubToken';

// Object URLs keyed by proxy src so repeated renders of the same asset (the
// same author's avatar on every comment, re-mounts under virtualization)
// share one authorized fetch and one blob. Entries live for the page's
// lifetime — the set of distinct assets on a diff is small, so the object
// URLs are intentionally never revoked. A failed fetch removes its entry and
// resolves to the plain proxy URL so a public asset still renders anonymously.
const objectURLBySrc = new Map<string, Promise<string>>();

// A data: URI that is not a decodable image: assigning it to <img src> fires
// the element's native error event without issuing a network request. Stands
// in for the plain proxy URL on require-login deployments, where the server
// rejects every tokenless request with 401, so requesting it would only spam
// the console before reaching the same onError.
const UNLOADABLE_ASSET_SRC = 'data:,';

function resolveAssetSrc(src: string, requireLogin: boolean): Promise<string> {
  const token = readStoredGitHubToken();
  if (token === '') {
    return Promise.resolve(requireLogin ? UNLOADABLE_ASSET_SRC : src);
  }
  let pending = objectURLBySrc.get(src);
  if (pending == null) {
    pending = fetch(src, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Asset request failed: ${response.status}`);
        }
        return URL.createObjectURL(await response.blob());
      })
      .catch(() => {
        objectURLBySrc.delete(src);
        return requireLogin ? UNLOADABLE_ASSET_SRC : src;
      });
    objectURLBySrc.set(src, pending);
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
  const [resolvedSrc, setResolvedSrc] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void resolveAssetSrc(src, requireLogin).then((resolved) => {
      if (!cancelled) {
        setResolvedSrc(resolved);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [src, requireLogin]);

  return <img {...rest} alt={alt ?? ''} loading="lazy" src={resolvedSrc} />;
}
