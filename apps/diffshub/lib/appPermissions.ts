import { GITHUB_APP_OWNER_FIX } from './githubAppAccess';

// What a DiffsHub GitHub App installation allows, and which features need
// what. GitHub's per-object `viewerCan*` flags ignore the installation, so the
// UI checks this instead to block controls GitHub would refuse.

export type AppPermissionLevel = 'admin' | 'read' | 'write';

// GitHub's installation permission map, e.g. { contents: 'read' }. A missing
// key means the installation has no access of that kind.
export type AppPermissions = Readonly<Record<string, AppPermissionLevel>>;

// The /api/github-app-permissions payload: each org's installation
// permissions keyed by lowercased login, or null when the sign-in isn't a
// GitHub App token (a PAT or OAuth App token), which nothing here restricts.
export interface AppInstallationsPayload {
  installations: Readonly<Record<string, AppPermissions>> | null;
}

interface AppRequirement {
  permission: string;
  level: AppPermissionLevel;
  // GitHub's name for the permission, as org owners see it in settings.
  label: string;
}

const CONTENTS_WRITE: AppRequirement = {
  permission: 'contents',
  level: 'write',
  label: 'Contents: Read and write',
};

// The installation permission each gated feature needs.
const APP_REQUIREMENTS = {
  // Commits from the editor, suggestion commits, and conflict merges.
  commit: CONTENTS_WRITE,
  // Draft and ready-for-review use GraphQL mutations that check Contents.
  draft: CONTENTS_WRITE,
  // A guess (GitHub doesn't document it); session refusals cover a wrong one.
  resolveThread: CONTENTS_WRITE,
  checkRuns: { permission: 'checks', level: 'read', label: 'Checks: Read' },
} satisfies Record<string, AppRequirement>;

export type AppFeature = keyof typeof APP_REQUIREMENTS;

const LEVEL_RANK: Record<AppPermissionLevel, number> = {
  read: 1,
  write: 2,
  admin: 3,
};

// Why `owner`'s installation can't do `feature`, as tooltip text, or null
// when it can or when there's nothing to go on: no GitHub App sign-in, or an
// org missing from the user's installation list (GitHub lists only orgs the
// user has explicit access to, so absence doesn't prove the app is missing).
export function describeMissingAppPermission(
  payload: AppInstallationsPayload | null,
  owner: string,
  feature: AppFeature
): string | null {
  const permissions = payload?.installations?.[owner.toLowerCase()];
  if (permissions == null) {
    return null;
  }
  const requirement = APP_REQUIREMENTS[feature];
  const granted = permissions[requirement.permission];
  if (granted != null && LEVEL_RANK[granted] >= LEVEL_RANK[requirement.level]) {
    return null;
  }
  return `Needs the DiffsHub GitHub App's ${requirement.label} permission in ${owner}. ${GITHUB_APP_OWNER_FIX}`;
}
