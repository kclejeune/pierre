'use client';

import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';

import { useGitHubEnvironment } from './GitHubEnvironmentProvider';
import { readStoredGitHubToken, subscribeToGitHubToken } from './githubSession';

// Paths that must stay reachable without credentials: the login page itself
// and the OAuth completion page that saves the token into storage.
function isLoginExemptPath(pathname: string): boolean {
  return pathname === '/login' || pathname.startsWith('/auth/');
}

// When the deployment requires login, gates every page behind a saved GitHub
// token: visitors without one are redirected to /login carrying the URL they
// were headed to, and sent back once a token lands in storage. The token
// lives in localStorage, so only the browser can run this check — gated pages
// render nothing until it passes to avoid flashing protected content before
// the redirect.
//
// The gate keeps watching the slot after mount, so *any* sign-out — the
// viewer clearing their token, an expired GitHub App session that could not
// be refreshed, a sign-out in another tab — lands on /login the same way.
// Nothing else in the app needs to know how to redirect.
export function RequireLoginGate({ children }: { children: ReactNode }) {
  const { requireLogin } = useGitHubEnvironment();
  const pathname = usePathname();
  const gated = requireLogin && !isLoginExemptPath(pathname);
  const [allowed, setAllowed] = useState(!gated);

  useEffect(() => {
    if (!gated) {
      setAllowed(true);
      return;
    }
    function check(): void {
      if (readStoredGitHubToken() !== '') {
        setAllowed(true);
        return;
      }
      const { hash, pathname: currentPath, search } = window.location;
      const returnTo = `${currentPath}${search}${hash}`;
      window.location.replace(
        `/login?returnTo=${encodeURIComponent(returnTo)}`
      );
    }
    check();
    return subscribeToGitHubToken(check);
  }, [gated]);

  return allowed ? children : null;
}
