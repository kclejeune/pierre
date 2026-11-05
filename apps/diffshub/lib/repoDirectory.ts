// The viewer's repository directory: the payload /api/github-repos serves
// (the viewer, their organizations, and their affiliated repos) and the pure
// parsing that builds it.

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
