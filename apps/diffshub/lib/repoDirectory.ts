// The dashboards' repository directory: the payload /api/github-repos
// serves (the viewer, their organizations, and their affiliated repos) plus
// the pure grouping/filtering the browse and pulls pages share. Grouping and
// filtering are pure functions so they stay unit-testable.

export interface RepoDirectoryOwner {
  avatarUrl?: string;
  kind: 'org' | 'user';
  login: string;
}

export interface RepoDirectoryRepo {
  archived: boolean;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  pushedAt?: string;
}

export interface RepoDirectoryPayload {
  // Organizations the viewer belongs to (possibly without repos in `repos`).
  orgs: RepoDirectoryOwner[];
  // Owners seen in the repo listing (collaborator repos introduce owners the
  // org membership listing does not know).
  repoOwners: RepoDirectoryOwner[];
  // Most recently pushed first, as GitHub returns them.
  repos: RepoDirectoryRepo[];
  viewer: RepoDirectoryOwner | null;
}

export interface RepoDirectoryGroup {
  owner: RepoDirectoryOwner;
  repos: RepoDirectoryRepo[];
}

// Buckets the repo listing by owner. Group order: the viewer first, then
// every other owner by their most recently pushed repo (the listing is
// already pushed-recency ordered), then member organizations with no repos
// in the listing — those still render (empty) so every org shows up as a
// filter target.
export function groupRepoDirectory(
  payload: RepoDirectoryPayload
): RepoDirectoryGroup[] {
  const ownersByLogin = new Map<string, RepoDirectoryOwner>();
  for (const owner of [
    ...(payload.viewer == null ? [] : [payload.viewer]),
    ...payload.repoOwners,
    ...payload.orgs,
  ]) {
    if (!ownersByLogin.has(owner.login)) {
      ownersByLogin.set(owner.login, owner);
    }
  }
  const groups = new Map<string, RepoDirectoryGroup>();
  const addGroup = (login: string) => {
    const existing = groups.get(login);
    if (existing != null) {
      return existing;
    }
    const owner = ownersByLogin.get(login) ?? { kind: 'user' as const, login };
    const group: RepoDirectoryGroup = { owner, repos: [] };
    groups.set(login, group);
    return group;
  };
  if (payload.viewer != null) {
    addGroup(payload.viewer.login);
  }
  for (const repo of payload.repos) {
    addGroup(repo.owner).repos.push(repo);
  }
  for (const org of payload.orgs) {
    addGroup(org.login);
  }
  return [...groups.values()];
}

// The search box's filter: a query matching an owner keeps that whole group,
// otherwise groups are narrowed to the repos whose name (or full name)
// matches, and groups left with nothing drop out. Case-insensitive.
export function filterRepoGroups(
  groups: readonly RepoDirectoryGroup[],
  query: string
): RepoDirectoryGroup[] {
  const normalized = query.trim().toLowerCase();
  if (normalized === '') {
    return [...groups];
  }
  const filtered: RepoDirectoryGroup[] = [];
  for (const group of groups) {
    if (group.owner.login.toLowerCase().includes(normalized)) {
      filtered.push(group);
      continue;
    }
    const repos = group.repos.filter(
      (repo) =>
        repo.name.toLowerCase().includes(normalized) ||
        repo.fullName.toLowerCase().includes(normalized)
    );
    if (repos.length > 0) {
      filtered.push({ owner: group.owner, repos });
    }
  }
  return filtered;
}
