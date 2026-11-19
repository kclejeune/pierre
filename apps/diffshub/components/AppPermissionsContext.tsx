'use client';

import { createContext, type ReactNode, useContext } from 'react';

import { storedGitHubTokenHeaders } from './githubSession';
import { useGitHubToken } from './useGitHubToken';
import {
  type AppFeature,
  type AppInstallationsPayload,
  describeMissingAppPermission,
} from '@/lib/appPermissions';
import { createCachedLookup } from '@/lib/cachedLookup';
import { fetchReportingRejection } from '@/lib/rejectedCredential';

// Lets a control in a pull-request view ask whether the DiffsHub GitHub App's
// installation on the pull's org allows its feature (lib/appPermissions'
// documented requirements), so it renders blocked with the reason instead of
// failing on click. Only the permissions GitHub reports for the installation
// decide this; a refusal GitHub gives anyway is shown as that request's
// error and doesn't block the control afterwards.

// The open pull's owner login, or null outside pull views.
const PullOwnerContext = createContext<string | null>(null);

export function AppPermissionsProvider({
  children,
  owner,
}: {
  children: ReactNode;
  owner: string | undefined;
}) {
  return <PullOwnerContext value={owner ?? null}>{children}</PullOwnerContext>;
}

// Keyed by the non-secret credential version, like useGitHubUser. A failed
// lookup reads as null, which restricts nothing, and retries after the
// cache's short failure TTL.
const installationsByVersion = createCachedLookup(
  (_version: number) =>
    fetchReportingRejection('/api/github-app-permissions', {
      headers: storedGitHubTokenHeaders(),
    }).then((response) =>
      response.ok ? (response.json() as Promise<AppInstallationsPayload>) : null
    ),
  { maxEntries: 8 }
);

// Why the pull's org won't let the app do `feature` (tooltip text), or null
// when nothing says it can't, including outside pull views and while the
// permissions load.
export function useAppPermissionBlock(feature: AppFeature): string | null {
  const owner = useContext(PullOwnerContext);
  const { hasToken, tokenVersion } = useGitHubToken();
  const payload = installationsByVersion.useValue(
    owner != null && hasToken ? tokenVersion : null
  );
  return owner == null
    ? null
    : describeMissingAppPermission(payload, owner, feature);
}
