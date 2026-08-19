'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { saveGitHubGrantToStorage } from '@/components/githubSession';
import { sanitizeReturnTo } from '@/lib/githubOAuth';
import { parseGrantFragment } from '@/lib/githubOAuthGrant';

// Landing page for the OAuth callback redirect. The grant arrives in the URL
// fragment (so it never hits server logs); this page moves the token into the
// same localStorage slot the PAT flow uses — plus the refresh session when
// GitHub issued an expiring token — scrubs it from the address bar and
// history, and then hard-navigates back to where sign-in started so the
// viewer re-reads the token fresh on mount.
export function GitHubAuthCompletePage() {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const error = url.searchParams.get('error');
    const returnTo = sanitizeReturnTo(url.searchParams.get('returnTo'));
    const grant = parseGrantFragment(url.hash);

    if (grant != null) {
      saveGitHubGrantToStorage(grant);
      // Drop the fragment from the current history entry before leaving so the
      // token cannot be recovered through back-navigation.
      window.history.replaceState(window.history.state, '', '/auth/github');
      window.location.replace(returnTo);
      return;
    }

    setErrorMessage(error ?? 'GitHub sign-in did not return a token.');
  }, []);

  return (
    <main className="flex min-h-[100svh] flex-col items-center justify-center gap-3 px-6 text-center">
      {errorMessage == null ? (
        <p className="text-muted-foreground text-sm">Completing sign-in…</p>
      ) : (
        <>
          <h1 className="text-lg font-semibold">GitHub sign-in failed</h1>
          <p className="text-muted-foreground max-w-96 text-sm text-pretty">
            {errorMessage}
          </p>
          <Link href="/" className="inline-link text-sm">
            Back to DiffsHub
          </Link>
        </>
      )}
    </main>
  );
}
