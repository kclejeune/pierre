'use client';

import {
  createContext,
  type ReactNode,
  useContext,
  useSyncExternalStore,
} from 'react';

import { storedGitHubTokenHeaders } from './githubSession';
import { useGitHubToken } from './useGitHubToken';
import {
  type AppFeature,
  type AppInstallationsPayload,
  describeMissingAppPermission,
} from '@/lib/appPermissions';
import { createCachedLookup } from '@/lib/cachedLookup';
import { GITHUB_APP_OWNER_FIX } from '@/lib/githubAppAccess';
import { APIRequestError } from '@/lib/pullCommentsClient';
import { fetchReportingRejection } from '@/lib/rejectedCredential';

// Lets a control in a pull-request view ask whether the DiffsHub GitHub App's
// installation on the pull's org allows its feature (lib/appPermissions), so
// it renders blocked with the reason instead of failing on click. Besides the
// permissions GitHub reports up front, refusals seen this session count too,
// covering orgs the installation list omits and wrong requirement guesses.

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

// Refusals GitHub has given this session, as `${tokenVersion}:${owner}:
// ${feature}`: a refusal belongs to the credential that got it, so signing in
// differently (say, a PAT no installation limits) starts clean. Replaced
// (never mutated) on each addition so the set itself is the store snapshot.
let refusals: ReadonlySet<string> = new Set();
const refusalListeners = new Set<() => void>();

function subscribeToRefusals(listener: () => void): () => void {
  refusalListeners.add(listener);
  return () => refusalListeners.delete(listener);
}

function refusalKey(
  tokenVersion: number,
  owner: string,
  feature: AppFeature
): string {
  return `${tokenVersion}:${owner.toLowerCase()}:${feature}`;
}

// Whether a failed request was GitHub refusing the app's installation (the
// server's 'app-refusal' code), not some other failure.
export function isAppRefusalError(error: unknown): boolean {
  return error instanceof APIRequestError && error.code === 'app-refusal';
}

// Remembers `error` as a refusal of `feature` in `owner` for this credential
// when it is one, so the control blocks itself from then on.
export function rememberAppRefusal(
  tokenVersion: number,
  owner: string,
  feature: AppFeature,
  error: unknown
): void {
  const key = refusalKey(tokenVersion, owner, feature);
  if (!isAppRefusalError(error) || refusals.has(key)) {
    return;
  }
  refusals = new Set([...refusals, key]);
  for (const listener of refusalListeners) {
    listener();
  }
}

// Whether `refusals` holds a refusal of `feature` in `owner` for the
// credential at `tokenVersion`.
export function hasRememberedRefusal(
  refusals: ReadonlySet<string>,
  tokenVersion: number,
  owner: string,
  feature: AppFeature
): boolean {
  return refusals.has(refusalKey(tokenVersion, owner, feature));
}

// The current remembered refusals, for hasRememberedRefusal outside React.
export function readRememberedRefusals(): ReadonlySet<string> {
  return refusals;
}

// Why the pull's org won't let the app do `feature` (tooltip text), or null
// when nothing says it can't, including outside pull views and while the
// permissions load.
export function useAppPermissionBlock(feature: AppFeature): string | null {
  const owner = useContext(PullOwnerContext);
  const { hasToken, tokenVersion } = useGitHubToken();
  const payload = installationsByVersion.useValue(
    owner != null && hasToken ? tokenVersion : null
  );
  const seen = useSyncExternalStore(
    subscribeToRefusals,
    () => refusals,
    () => refusals
  );
  if (owner == null) {
    return null;
  }
  return (
    describeMissingAppPermission(payload, owner, feature) ??
    (hasRememberedRefusal(seen, tokenVersion, owner, feature)
      ? `GitHub refused this for the DiffsHub GitHub App in ${owner}; its installation there is missing a permission. ${GITHUB_APP_OWNER_FIX}`
      : null)
  );
}

// rememberAppRefusal bound to the open pull's org, for a control's failure
// handler; a no-op outside pull views.
export function useRememberAppRefusal(): (
  feature: AppFeature,
  error: unknown
) => void {
  const owner = useContext(PullOwnerContext);
  const { tokenVersion } = useGitHubToken();
  return (feature, error) => {
    if (owner != null) {
      rememberAppRefusal(tokenVersion, owner, feature, error);
    }
  };
}
