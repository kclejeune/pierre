import { describe, expect, test } from 'bun:test';

import {
  filterRepoGroups,
  groupRepoDirectory,
  mergeRepoDirectoryPayload,
  type RepoDirectoryPayload,
} from '../repoDirectory';

function repo(owner: string, name: string) {
  return {
    archived: false,
    fullName: `${owner}/${name}`,
    name,
    owner,
    private: false,
  };
}

const PAYLOAD: RepoDirectoryPayload = {
  orgs: [
    { avatarUrl: 'https://a/acme.png', kind: 'org', login: 'acme' },
    { kind: 'org', login: 'empty-org' },
  ],
  repoOwners: [
    { kind: 'user', login: 'kclejeune' },
    { avatarUrl: 'https://a/acme.png', kind: 'org', login: 'acme' },
    { kind: 'user', login: 'friend' },
  ],
  // Pushed-recency order across owners, deliberately interleaved.
  repos: [
    repo('acme', 'widgets'),
    repo('kclejeune', 'pierre'),
    repo('friend', 'shared-tool'),
    repo('acme', 'gadgets'),
  ],
  viewer: { avatarUrl: 'https://a/kc.png', kind: 'user', login: 'kclejeune' },
};

describe('groupRepoDirectory', () => {
  test('groups repos by owner: viewer first, then recency, then empty orgs', () => {
    const groups = groupRepoDirectory(PAYLOAD);
    expect(groups.map((group) => group.owner.login)).toEqual([
      'kclejeune',
      'acme',
      'friend',
      'empty-org',
    ]);
    expect(groups[1].repos.map((r) => r.name)).toEqual(['widgets', 'gadgets']);
    // An org with no repos in the listing still appears as a filter target.
    expect(groups[3].repos).toEqual([]);
    // Owner metadata (avatar) carries onto the group.
    expect(groups[0].owner.avatarUrl).toBe('https://a/kc.png');
  });

  test('tolerates a missing viewer', () => {
    const groups = groupRepoDirectory({ ...PAYLOAD, viewer: null });
    expect(groups[0].owner.login).toBe('acme');
  });
});

describe('filterRepoGroups', () => {
  const groups = groupRepoDirectory(PAYLOAD);

  test('an empty query keeps everything', () => {
    expect(filterRepoGroups(groups, '  ')).toEqual(groups);
  });

  test('an owner match keeps the whole group', () => {
    const filtered = filterRepoGroups(groups, 'ACME');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].repos.map((r) => r.name)).toEqual([
      'widgets',
      'gadgets',
    ]);
  });

  test('a repo match narrows groups and drops empty ones', () => {
    const filtered = filterRepoGroups(groups, 'widget');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].owner.login).toBe('acme');
    expect(filtered[0].repos.map((r) => r.name)).toEqual(['widgets']);
  });

  test('full-name matches work across the owner/name boundary', () => {
    const filtered = filterRepoGroups(groups, 'friend/shared');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].repos.map((r) => r.name)).toEqual(['shared-tool']);
  });

  test('no match returns nothing', () => {
    expect(filterRepoGroups(groups, 'zzz')).toEqual([]);
  });
});

describe('mergeRepoDirectoryPayload', () => {
  test('appends continuation pages without duplicating repositories', () => {
    const merged = mergeRepoDirectoryPayload(
      { ...PAYLOAD, nextPage: 4 },
      {
        orgs: [],
        repoOwners: [{ kind: 'org', login: 'new-org' }],
        repos: [repo('acme', 'widgets'), repo('new-org', 'new-repo')],
        viewer: null,
        nextPage: 5,
      }
    );
    expect(merged.repos.map((entry) => entry.fullName)).toEqual([
      'acme/widgets',
      'kclejeune/pierre',
      'friend/shared-tool',
      'acme/gadgets',
      'new-org/new-repo',
    ]);
    expect(merged.viewer).toEqual(PAYLOAD.viewer);
    expect(merged.nextPage).toBe(5);
  });
});
