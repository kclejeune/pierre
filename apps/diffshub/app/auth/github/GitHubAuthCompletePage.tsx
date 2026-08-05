'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { saveGitHubTokenToStorage } from '@/components/useGitHubToken';
import { sanitizeReturnTo } from '@/lib/githubOAuth';

// Landing page for the OAuth callback redirect. The token arrives in the URL
// fragment (so it never hits server logs); this page moves it into the same
// localStorage slot the PAT flow uses, scrubs it from the address bar and
// history, and then hard-navigates back to where sign-in started so the
// viewer re-reads the token fresh on mount.
export function GitHubAuthCompletePage() {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const error = url.searchParams.get('error');
    const returnTo = sanitizeReturnTo(url.searchParams.get('returnTo'));
    const token = parseTokenFromHash(url.hash);

    if (token != null) {
      saveGitHubTokenToStorage(token);
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

function parseTokenFromHash(hash: string): string | undefined {
  if (!hash.startsWith('#')) {
    return undefined;
  }
  const token = new URLSearchParams(hash.slice(1)).get('token')?.trim();
  return token == null || token === '' ? undefined : token;
}
