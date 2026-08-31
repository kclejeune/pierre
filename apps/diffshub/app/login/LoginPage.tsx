'use client';

import { useEffect } from 'react';

import { DiffsHubLogo } from '@/components/DiffsHubLogo';
import { useGitHubEnvironment } from '@/components/GitHubEnvironmentProvider';
import { consumeReauthIntent } from '@/components/githubSession';
import { GitHubTokenControl } from '@/components/GitHubTokenControl';
import { useGitHubToken } from '@/components/useGitHubToken';
import { githubLoginHref, sanitizeReturnTo } from '@/lib/githubOAuth';

// Sign-in page for deployments that require credentials
// (DIFFSHUB_REQUIRE_LOGIN). RequireLoginGate sends anonymous visitors here
// with their original destination in ?returnTo; as soon as a token lands in
// storage — a pasted PAT, or the OAuth round trip returning through the
// completion page — the effect below sends them back to it.
//
// Visitors whose credentials *died* (rather than never existed) arrive with
// a re-auth stamp (see githubSession) and skip the form entirely when OAuth
// is configured: they already chose GitHub sign-in once, and with a live
// GitHub/SSO session the authorize round trip returns without interaction.
export function LoginPage() {
  const { clearToken, hasToken, setToken } = useGitHubToken();
  const { oauthEnabled, patInputEnabled } = useGitHubEnvironment();

  useEffect(() => {
    const url = new URL(window.location.href);
    const returnTo = sanitizeReturnTo(url.searchParams.get('returnTo'));
    if (hasToken) {
      window.location.replace(returnTo);
      return;
    }
    if (consumeReauthIntent() && oauthEnabled) {
      window.location.replace(githubLoginHref(returnTo));
    }
  }, [hasToken, oauthEnabled]);

  return (
    <main className="flex min-h-[100svh] flex-col items-center justify-center px-6">
      <section className="w-full max-w-md space-y-4">
        <h1 className="flex items-center gap-1.5 text-2xl font-semibold tracking-tight">
          <DiffsHubLogo />
          DiffsHub
        </h1>
        <p className="text-muted-foreground text-sm text-pretty">
          This deployment requires GitHub credentials.{' '}
          {patInputEnabled ? 'Sign in or save a token' : 'Sign in'} to continue
          to your destination.
        </p>
        <div className="bg-accent md:bg-background overflow-hidden rounded-lg border">
          <GitHubTokenControl
            active={hasToken}
            className="px-4 py-3"
            onClear={clearToken}
            onSave={setToken}
            title="GitHub access"
          />
        </div>
      </section>
    </main>
  );
}
