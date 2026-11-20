'use client';

import { createContext, type ReactNode, useContext } from 'react';

import {
  GITHUB_DOTCOM_WEB_URL,
  type GitHubClientEnvironment,
} from '@/lib/githubEnvironment';
import { DEFAULT_PULL_MUTING_CONFIG } from '@/lib/muteRules';

// Default matches a plain github.com deployment so components render sensibly
// even if a caller forgets to mount the provider (e.g. isolated tests).
const DEFAULT_CLIENT_ENVIRONMENT: GitHubClientEnvironment = {
  host: new URL(GITHUB_DOTCOM_WEB_URL).hostname,
  isGitHubDotCom: true,
  muting: DEFAULT_PULL_MUTING_CONFIG,
  oauthEnabled: false,
  patInputEnabled: true,
  requireLogin: false,
  tokenEncryptionRequired: false,
  webURL: GITHUB_DOTCOM_WEB_URL,
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
