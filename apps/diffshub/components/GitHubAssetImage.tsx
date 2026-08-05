'use client';

import { type ImgHTMLAttributes, useEffect, useState } from 'react';

import { readStoredGitHubToken } from './useGitHubToken';

// Object URLs keyed by proxy src so repeated renders of the same asset (the
// same author's avatar on every comment, re-mounts under virtualization)
// share one authorized fetch and one blob. Entries live for the page's
// lifetime — the set of distinct assets on a diff is small, so the object
// URLs are intentionally never revoked. A failed fetch removes its entry and
// resolves to the plain proxy URL so the server-token fallback still renders.
const objectURLBySrc = new Map<string, Promise<string>>();

function resolveAssetSrc(src: string): Promise<string> {
  const token = readStoredGitHubToken();
  if (token === '') {
    return Promise.resolve(src);
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
        return src;
      });
    objectURLBySrc.set(src, pending);
  }
  return pending;
}

// An image served through one of the same-origin GitHub asset proxies
// (/api/github-doc-asset, /api/github-web-asset). <img> requests cannot carry
// an Authorization header, so when the viewer has a saved GitHub token the
// asset is fetched with the header and shown from an object URL — private
// repos and GHES then load images with the viewer's own credentials instead
// of requiring the server fallback token. Without a saved token (or when the
// authorized fetch fails) the proxy URL is used directly, letting the server
// fall back to its own token; if that fails too, the native onError fires so
// callers can render a fallback.
export function GitHubAssetImage({
  src,
  alt,
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const [resolvedSrc, setResolvedSrc] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void resolveAssetSrc(src).then((resolved) => {
      if (!cancelled) {
        setResolvedSrc(resolved);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [src]);

  return <img {...rest} alt={alt ?? ''} loading="lazy" src={resolvedSrc} />;
}
