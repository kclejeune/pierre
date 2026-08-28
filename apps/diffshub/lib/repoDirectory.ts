// The dashboards' repository directory: the payload /api/github-repos
// serves (the viewer, their organizations, and their affiliated repos) plus
// the pure parsing and grouping/filtering around it. Everything here is a
// pure function so it stays unit-testable without network.

import { asRecord } from './untypedJson';

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
  // Next /user/repos page when this payload is intentionally partial.
  nextPage?: number;
}

export interface RepoDirectoryGroup {
  owner: RepoDirectoryOwner;
  repos: RepoDirectoryRepo[];
}

export function mergeRepoDirectoryPayload(
  current: RepoDirectoryPayload,
  next: RepoDirectoryPayload
): RepoDirectoryPayload {
  const ownerKey = (owner: RepoDirectoryOwner) => owner.login.toLowerCase();
  const owners = new Map(
    current.repoOwners.map((owner) => [ownerKey(owner), owner])
  );
  for (const owner of next.repoOwners) {
    owners.set(ownerKey(owner), owner);
  }
  const repos = new Map(
    current.repos.map((repo) => [repo.fullName.toLowerCase(), repo])
  );
  for (const repo of next.repos) {
    repos.set(repo.fullName.toLowerCase(), repo);
  }
  return {
    orgs: current.orgs,
    repoOwners: [...owners.values()],
    repos: [...repos.values()],
    viewer: current.viewer,
    nextPage: next.nextPage,
  };
}

// One owner (user or org) from a GitHub payload; `fallbackKind` labels
// owners whose `type` field is absent (e.g. the /user/orgs listing).
export function parseRepoDirectoryOwner(
  value: unknown,
  fallbackKind: 'org' | 'user'
): RepoDirectoryOwner | null {
  const record = asRecord(value);
  const login = record?.login;
  if (typeof login !== 'string' || login === '') {
    return null;
  }
  return {
    avatarUrl:
      typeof record?.avatar_url === 'string' ? record.avatar_url : undefined,
    kind: record?.type === 'Organization' ? 'org' : fallbackKind,
    login,
  };
}

// One repository from a /user/repos page, with its owner so the directory
// can label groups the org listing does not know about.
export function parseRepoDirectoryRepo(
  value: unknown
): { owner: RepoDirectoryOwner; repo: RepoDirectoryRepo } | null {
  const record = asRecord(value);
  const name = record?.name;
  const owner = parseRepoDirectoryOwner(record?.owner, 'user');
  if (typeof name !== 'string' || name === '' || owner == null) {
    return null;
  }
  return {
    owner,
    repo: {
      archived: record?.archived === true,
      fullName: `${owner.login}/${name}`,
      name,
      owner: owner.login,
      private: record?.private === true,
      pushedAt:
        typeof record?.pushed_at === 'string' ? record.pushed_at : undefined,
    },
  };
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
