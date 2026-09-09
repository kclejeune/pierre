'use client';

import {
  type ImgHTMLAttributes,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';

import { useGitHubEnvironment } from './GitHubEnvironmentProvider';
import {
  getGitHubTokenSnapshot,
  getServerGitHubTokenSnapshot,
  readStoredGitHubToken,
  subscribeToGitHubToken,
} from './githubSession';

interface ResolvedAsset {
  objectURL?: string;
  src: string;
}

// A data: URI that is not a decodable image: assigning it to <img src> fires
// the element's native error event without issuing a network request. Stands
// in for the plain proxy URL on require-login deployments, where the server
// rejects every tokenless request with 401, so requesting it would only spam
// the console before reaching the same onError.
const UNLOADABLE_ASSET_SRC = 'data:,';

// In-flight authorized asset fetches, keyed by asset and credential. A comment
// thread renders the same author's avatar on every row, so without this each
// <img> issues its own request for identical bytes — and an HTTP cache cannot
// help, because it only serves responses that have already finished.
//
// Only *pending* fetches are shared. The entry is dropped as soon as the fetch
// settles, so the map holds nothing between bursts: there is no eviction policy
// to tune and no way for it to retain blobs. Each mount still creates and
// revokes its own object URL from the shared blob, keeping blob lifetime owned
// by the component that renders it.
const pendingAssetBlobs = new Map<string, Promise<Blob>>();

function fetchAssetBlob(
  assetKey: string,
  src: string,
  token: string
): Promise<Blob> {
  const inFlight = pendingAssetBlobs.get(assetKey);
  if (inFlight != null) {
    return inFlight;
  }

  const shared = fetch(src, {
    // Cache-Control and Vary on the proxy response let the browser cache this
    // request privately without reusing it across credential changes.
    headers: { Authorization: `Bearer ${token}` },
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Asset request failed: ${response.status}`);
      }
      return await response.blob();
    })
    .finally(() => {
      pendingAssetBlobs.delete(assetKey);
    });
  pendingAssetBlobs.set(assetKey, shared);
  return shared;
}

function resolveAssetSrc(
  assetKey: string,
  src: string,
  requireLogin: boolean,
  token: string
): Promise<ResolvedAsset> {
  if (token === '') {
    return Promise.resolve({
      src: requireLogin ? UNLOADABLE_ASSET_SRC : src,
    });
  }
  return fetchAssetBlob(assetKey, src, token)
    .then((blob) => {
      const objectURL = URL.createObjectURL(blob);
      return { objectURL, src: objectURL };
    })
    .catch(() => ({ src: requireLogin ? UNLOADABLE_ASSET_SRC : src }));
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
  const { token } = useSyncExternalStore(
    subscribeToGitHubToken,
    getGitHubTokenSnapshot,
    getServerGitHubTokenSnapshot
  );
  // During hydration useSyncExternalStore briefly exposes the tokenless
  // server snapshot. Reading storage here gives the effect its final token on
  // the first client render, and keeps the dependency stable when React then
  // swaps in the equivalent client snapshot.
  const liveToken = token === '' ? readStoredGitHubToken() : token;
  // The resolved src is stored with the source/credential it was fetched for.
  // On a credential change the effect cleanup revokes the old object URL
  // immediately, so rendering a src left over from the previous key would point
  // <img> at a revoked blob — a broken image, or briefly the previous viewer's
  // avatar. Rendering nothing until the replacement resolves avoids both.
  const assetKey = `${src}\0${requireLogin ? '1' : '0'}\0${liveToken}`;
  const [resolved, setResolved] = useState<{ key: string; src: string }>();

  useEffect(() => {
    let cancelled = false;
    let objectURL: string | undefined;
    void resolveAssetSrc(assetKey, src, requireLogin, liveToken).then(
      ({ objectURL: nextObjectURL, src: resolvedSrc }) => {
        if (cancelled) {
          if (nextObjectURL != null) {
            URL.revokeObjectURL(nextObjectURL);
          }
          return;
        }
        objectURL = nextObjectURL;
        setResolved({ key: assetKey, src: resolvedSrc });
      }
    );
    return () => {
      cancelled = true;
      if (objectURL != null) {
        URL.revokeObjectURL(objectURL);
      }
    };
  }, [assetKey, src, requireLogin, liveToken]);

  return (
    <img
      {...rest}
      alt={alt ?? ''}
      loading="lazy"
      src={resolved?.key === assetKey ? resolved.src : undefined}
    />
  );
}
