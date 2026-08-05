'use client';

import { createContext, type ReactNode, useContext } from 'react';

import type { GitHubClientEnvironment } from '@/lib/githubEnvironment';

// Default matches a plain github.com deployment so components render sensibly
// even if a caller forgets to mount the provider (e.g. isolated tests).
const DEFAULT_CLIENT_ENVIRONMENT: GitHubClientEnvironment = {
  host: 'github.com',
  isGitHubDotCom: true,
  oauthEnabled: false,
  webURL: 'https://github.com',
};

const GitHubEnvironmentContext = createContext<GitHubClientEnvironment>(
  DEFAULT_CLIENT_ENVIRONMENT
);

// Carries the server-resolved GitHub instance config (host, web URL, whether
// OAuth login is configured) into client components. The value is computed in
// the root layout from environment variables — no secrets cross this boundary.
export function GitHubEnvironmentProvider({
  children,
  environment,
}: {
  children: ReactNode;
  environment: GitHubClientEnvironment;
}) {
  return (
    <GitHubEnvironmentContext.Provider value={environment}>
      {children}
    </GitHubEnvironmentContext.Provider>
  );
}

export function useGitHubEnvironment(): GitHubClientEnvironment {
  return useContext(GitHubEnvironmentContext);
}
