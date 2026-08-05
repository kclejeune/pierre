'use client';

import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';

import { useGitHubEnvironment } from './GitHubEnvironmentProvider';
import { readStoredGitHubToken } from './useGitHubToken';

// Paths that must stay reachable without credentials: the login page itself
// and the OAuth completion page that saves the token into storage.
function isLoginExemptPath(pathname: string): boolean {
  return pathname === '/login' || pathname.startsWith('/auth/');
}

// When the deployment sets DIFFSHUB_REQUIRE_LOGIN, gates every page behind a
// saved GitHub token: visitors without one are redirected to /login carrying
// the URL they were headed to, and sent back once a token lands in storage.
// The token lives in localStorage, so only the browser can run this check —
// gated pages render nothing until it passes to avoid flashing protected
// content before the redirect.
export function RequireLoginGate({ children }: { children: ReactNode }) {
  const { requireLogin } = useGitHubEnvironment();
  const pathname = usePathname();
  const gated = requireLogin && !isLoginExemptPath(pathname);
  const [allowed, setAllowed] = useState(!gated);

  useEffect(() => {
    if (!gated || readStoredGitHubToken() !== '') {
      setAllowed(true);
      return;
    }
    const { hash, pathname: currentPath, search } = window.location;
    const returnTo = `${currentPath}${search}${hash}`;
    window.location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }, [gated]);

  return allowed ? children : null;
}
