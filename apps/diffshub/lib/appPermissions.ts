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

interface AppPermissionNeed {
  permission: string;
  level: AppPermissionLevel;
  // GitHub's name for the permission, as org owners see it in settings.
  label: string;
}

// A feature's requirement: any one of `anyOf` suffices (GitHub lists some
// endpoints under several permissions, any of which works).
interface AppRequirement {
  anyOf: readonly AppPermissionNeed[];
}

const CONTENTS_WRITE: AppPermissionNeed = {
  permission: 'contents',
  level: 'write',
  label: 'Contents: Read and write',
};
const PULL_REQUESTS_WRITE: AppPermissionNeed = {
  permission: 'pull_requests',
  level: 'write',
  label: 'Pull requests: Read and write',
};
const ISSUES_WRITE: AppPermissionNeed = {
  permission: 'issues',
  level: 'write',
  label: 'Issues: Read and write',
};

const only = (need: AppPermissionNeed): AppRequirement => ({ anyOf: [need] });

// The installation permission each feature needs, from GitHub's
// "Permissions required for GitHub Apps" reference
// (docs.github.com/en/enterprise-server@3.20/rest/authentication/permissions-required-for-github-apps).
// Controls are blocked up front from this table rather than after GitHub
// refuses them. GitHub documents permissions only for REST endpoints; the
// features that go through GraphQL mutations with no REST counterpart
// (draft, resolveThread, the merge queue and auto-merge, which share
// `merge`) take the permission of the REST endpoint that changes the same
// thing, noted per entry.
const APP_REQUIREMENTS: Record<AppFeature, AppRequirement> = {
  // GET /commits/{ref}/check-runs: Checks read.
  checkRuns: only({
    permission: 'checks',
    level: 'read',
    label: 'Checks: Read',
  }),
  // POST /git/commits and PATCH /git/refs: editor commits, suggestion
  // commits, conflict merges.
  commit: only(CONTENTS_WRITE),
  // GraphQL convertPullRequestToDraft / markPullRequestReadyForReview, which
  // GitHub doesn't document. Both need Contents write: with Pull requests
  // write and Contents read GitHub answers "Resource not accessible by
  // integration", and raising only Contents to write makes them succeed
  // (github.com/cli/cli/issues/8910#issuecomment-3915365403, reproduced
  // with an Actions installation token). GHE 3.20 refused
  // convertPullRequestToDraft the same way for our installation with
  // Pull requests write and Contents read.
  draft: only(CONTENTS_WRITE),
  // PATCH /pulls/{number}: title, description, close and reopen.
  edit: only(PULL_REQUESTS_WRITE),
  // POST and DELETE /issues/{number}/labels: Issues or Pull requests write.
  label: { anyOf: [ISSUES_WRITE, PULL_REQUESTS_WRITE] },
  // PUT /pulls/{number}/merge: Contents write. The merge queue and
  // auto-merge (GraphQL) merge the same way.
  merge: only(CONTENTS_WRITE),
  // POST and DELETE /pulls/{number}/requested_reviewers.
  requestReviews: only(PULL_REQUESTS_WRITE),
  // GraphQL resolveReviewThread / unresolveReviewThread; review threads
  // live under the pull's reviews (Pull requests write).
  resolveThread: only(PULL_REQUESTS_WRITE),
  // POST /pulls/{number}/reviews: approve, request changes, comment.
  review: only(PULL_REQUESTS_WRITE),
};

export type AppFeature =
  | 'checkRuns'
  | 'commit'
  | 'draft'
  | 'edit'
  | 'label'
  | 'merge'
  | 'requestReviews'
  | 'resolveThread'
  | 'review';

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
  const { anyOf } = APP_REQUIREMENTS[feature];
  const met = anyOf.some(({ level, permission }) => {
    const granted = permissions[permission];
    return granted != null && LEVEL_RANK[granted] >= LEVEL_RANK[level];
  });
  if (met) {
    return null;
  }
  const labels = anyOf.map((need) => need.label).join(' or ');
  return `Needs the DiffsHub GitHub App's ${labels} permission in ${owner}. ${GITHUB_APP_OWNER_FIX}`;
}
