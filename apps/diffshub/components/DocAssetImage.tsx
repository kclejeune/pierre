'use client';

import { type ImgHTMLAttributes, useEffect, useState } from 'react';

import { readStoredGitHubToken } from './useGitHubToken';

// An image served through the doc-asset proxy. <img> requests cannot carry an
// Authorization header, so when the viewer has a saved GitHub token the asset
// is fetched with the header and shown from an object URL — private repos and
// GHES then load doc images with the viewer's own credentials instead of
// requiring the server fallback token. Without a saved token (or when the
// authorized fetch fails) the proxy URL is used directly, letting the server
// fall back to its own token.
export function DocAssetImage({
  src,
  alt,
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const [resolvedSrc, setResolvedSrc] = useState<string>();

  useEffect(() => {
    const token = readStoredGitHubToken();
    if (token === '') {
      setResolvedSrc(src);
      return;
    }
    const controller = new AbortController();
    let objectURL: string | undefined;
    fetch(src, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Doc asset request failed: ${response.status}`);
        }
        objectURL = URL.createObjectURL(await response.blob());
        setResolvedSrc(objectURL);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setResolvedSrc(src);
        }
      });
    return () => {
      controller.abort();
      if (objectURL != null) {
        URL.revokeObjectURL(objectURL);
      }
    };
  }, [src]);

  return <img {...rest} alt={alt ?? ''} loading="lazy" src={resolvedSrc} />;
}
