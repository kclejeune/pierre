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

// Object URLs keyed by proxy src and scoped to the credential that fetched
// them, so repeated renders of the same asset (the same author's avatar on
// every comment, re-mounts under virtualization) share one authorized fetch
// and one blob without carrying that result across sign-in or token rotation.
// Superseded object URLs are revoked when auth changes; a failed fetch removes
// its entry and resolves to the plain proxy URL so a public asset still renders
// anonymously.
interface CachedAsset {
  credential: string;
  objectURL?: string;
  pending: Promise<string>;
}

const objectURLBySrc = new Map<string, CachedAsset>();

// A data: URI that is not a decodable image: assigning it to <img src> fires
// the element's native error event without issuing a network request. Stands
// in for the plain proxy URL on require-login deployments, where the server
// rejects every tokenless request with 401, so requesting it would only spam
// the console before reaching the same onError.
const UNLOADABLE_ASSET_SRC = 'data:,';

function resolveAssetSrc(
  src: string,
  requireLogin: boolean,
  token: string
): Promise<string> {
  let cached = objectURLBySrc.get(src);
  if (token === '') {
    if (cached?.objectURL != null) {
      URL.revokeObjectURL(cached.objectURL);
    }
    objectURLBySrc.delete(src);
    return Promise.resolve(requireLogin ? UNLOADABLE_ASSET_SRC : src);
  }
  if (cached == null || cached.credential !== token) {
    if (cached?.objectURL != null) {
      URL.revokeObjectURL(cached.objectURL);
    }
    const pending = fetch(src, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Asset request failed: ${response.status}`);
        }
        const objectURL = URL.createObjectURL(await response.blob());
        const current = objectURLBySrc.get(src);
        if (current?.pending !== pending) {
          // Auth changed while the request was in flight; nobody can consume
          // this result, and it must not survive under the old credential.
          URL.revokeObjectURL(objectURL);
        } else {
          current.objectURL = objectURL;
        }
        return objectURL;
      })
      .catch(() => {
        // A credential can rotate while this request is in flight. Do not let
        // its late failure evict the newer credential's cached request.
        if (objectURLBySrc.get(src)?.pending === pending) {
          objectURLBySrc.delete(src);
        }
        return requireLogin ? UNLOADABLE_ASSET_SRC : src;
      });
    cached = { credential: token, pending };
    objectURLBySrc.set(src, cached);
  }
  return cached.pending;
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
  const [resolvedSrc, setResolvedSrc] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    // The subscribed token re-runs this effect on credential changes, but it
    // can lag in one direction: during hydration React reports the server
    // snapshot (always tokenless) even when storage holds a token, and a
    // tokenless resolve fires onError on consumers that permanently record
    // the failure. When the store reports no token, trust the live read.
    const liveToken = token === '' ? readStoredGitHubToken() : token;
    void resolveAssetSrc(src, requireLogin, liveToken).then((resolved) => {
      if (!cancelled) {
        setResolvedSrc(resolved);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [src, requireLogin, token]);

  return <img {...rest} alt={alt ?? ''} loading="lazy" src={resolvedSrc} />;
}
