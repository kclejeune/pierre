import { describe, expect, test } from 'bun:test';

import {
  buildRepoSections,
  buildRootSections,
  deriveRepoSearchQuery,
  type PaletteSection,
  parseRepoShorthand,
  type RepoSectionsInput,
  type RootSectionsInput,
} from '@/lib/paletteItems';

const directory = ['oven-sh/bun', 'kclejeune/pierre', 'kclejeune/dotfiles'];

const root = (overrides: Partial<RootSectionsInput>) =>
  buildRootSections({
    commands: [],
    directory,
    orgMatches: [],
    pinned: [],
    query: '',
    recentDiffs: [],
    recentRepos: [],
    remote: [],
    ...overrides,
  });

const outline = (sections: PaletteSection[]) =>
  sections.map((section) => [
    section.heading,
    section.items.map((item) => item.repo ?? item.key),
  ]);

const actionOf = (sections: PaletteSection[], heading: string) =>
  sections.find((section) => section.heading === heading)?.items[0]?.action;

describe('buildRootSections', () => {
  test('idle: page scopes, pins, recent repos, recent views, directory, commands', () => {
    const sections = root({
      commands: [{ id: 'go-pulls', label: 'Your pull requests' }],
      pinned: ['kclejeune/pierre'],
      recentDiffs: [{ path: '/oven-sh/bun/pull/1', title: 'Fix', viewedAt: 1 }],
      recentRepos: ['oven-sh/bun', 'kclejeune/pierre'],
      scopes: [{ id: 'scope-all', label: 'All repositories' }],
    });
    expect(outline(sections)).toEqual([
      ['Scopes', ['run:scope-all']],
      ['Pinned', ['kclejeune/pierre']],
      ['Recent repositories', ['oven-sh/bun']],
      ['Recently viewed', ['recent:/oven-sh/bun/pull/1']],
      ['Your repositories', ['kclejeune/dotfiles']],
      ['Commands', ['run:go-pulls']],
    ]);
    expect(sections[1].items[0].action).toEqual({
      type: 'select-repo',
      repo: 'kclejeune/pierre',
    });
  });

  test('typed: name matches first, then org and GitHub extras without repeats', () => {
    const sections = root({
      orgMatches: ['kclejeune/pierre', 'anduril/pier-sdk'],
      query: 'pier',
      remote: ['anduril/pier-sdk', 'pierrecomputer/pierre'],
    });
    expect(outline(sections)).toEqual([
      ['Repositories', ['kclejeune/pierre']],
      ['Your organizations', ['anduril/pier-sdk']],
      ['More on GitHub', ['pierrecomputer/pierre']],
    ]);
  });

  test('a complete owner/name nothing matched gets a direct entry', () => {
    const sections = root({ query: 'torvalds/linux' });
    expect(sections[0]).toMatchObject({
      heading: 'Go to',
      items: [{ repo: 'torvalds/linux' }],
    });
  });

  test('a remote match differing from the typed name only by case is not repeated', () => {
    const sections = root({
      orgMatches: ['acme/widgets'],
      query: 'Acme/Widgets',
      remote: ['ACME/widgets'],
    });
    const keys = sections.flatMap((section) =>
      section.items.map((item) => item.key)
    );
    expect(keys.filter((key) => key === 'repo:acme/widgets')).toHaveLength(1);
  });

  // Pasted links open the view they name.
  test.each([
    ['https://github.com/oven-sh/bun/pull/12', '/oven-sh/bun/pull/12'],
    [
      'https://github.com/oven-sh/bun/tree/main/src',
      '/oven-sh/bun/tree/main/src',
    ],
    [
      'https://github.com/oven-sh/bun/blob/main/README.md',
      '/oven-sh/bun/blob/main/README.md',
    ],
    [
      'https://github.com/oven-sh/bun/commit/abc1234',
      '/oven-sh/bun/commit/abc1234',
    ],
    ['oven-sh/bun/pull/12', '/oven-sh/bun/pull/12'],
  ])('a pasted %s opens %s', (query, path) => {
    expect(actionOf(root({ query }), 'Go to')).toEqual({
      type: 'navigate',
      path,
    });
  });

  test('a pasted link to this app opens in place, not as an external patch', () => {
    const sections = root({
      appHost: 'diffs.example',
      query: 'https://diffs.example/oven-sh/bun/pull/12?file=a.ts',
    });
    expect(actionOf(sections, 'Go to')).toEqual({
      type: 'navigate',
      path: '/oven-sh/bun/pull/12?file=a.ts',
    });
  });

  test('">" lists only commands, filtered by every word', () => {
    const commands = [
      { id: 'split', label: 'Split view', keywords: 'diff layout' },
      { id: 'unified', label: 'Unified view', keywords: 'diff layout' },
      { id: 'go-pulls', label: 'Your pull requests' },
    ];
    expect(outline(root({ commands, query: '>' }))).toEqual([
      ['Commands', ['run:split', 'run:unified', 'run:go-pulls']],
    ]);
    expect(outline(root({ commands, query: '> layout split' }))).toEqual([
      ['Commands', ['run:split']],
    ]);
    expect(root({ commands, query: '>nothing' })).toEqual([]);
  });
});

describe('parseRepoShorthand', () => {
  test('# steps into pull requests, @ into refs', () => {
    expect(parseRepoShorthand('oven-sh/bun#123')).toEqual({
      prefer: 'pulls',
      repo: 'oven-sh/bun',
      rest: '123',
    });
    expect(parseRepoShorthand('oven-sh/bun@')).toEqual({
      prefer: 'refs',
      repo: 'oven-sh/bun',
      rest: '',
    });
    expect(parseRepoShorthand('oven-sh/bun')).toBeNull();
    expect(parseRepoShorthand('https://github.com/a/b#x')).toBeNull();
  });
});

const refs = {
  branches: ['main', 'feature/palette', 'fix-ci'],
  defaultBranch: 'main',
  tags: ['v1.0.0'],
  truncated: false,
};
const pulls = [
  { number: 12, title: 'Add palette' },
  { number: 7, title: 'Fix CI' },
];
const inRepo = (overrides: Partial<RepoSectionsInput>) =>
  buildRepoSections({
    commands: [],
    prefer: 'pulls',
    pulls,
    query: '',
    refs,
    repo: 'oven-sh/bun',
    ...overrides,
  });

describe('buildRepoSections', () => {
  test('idle: the preferred list leads, then the other, then the repo itself', () => {
    expect(
      outline(inRepo({ currentPull: 12 })).map(([heading]) => heading)
    ).toEqual(['Open pull requests', 'Branches', 'Tags', 'Repository']);
    expect(
      outline(inRepo({ prefer: 'refs' })).map(([heading]) => heading)
    ).toEqual(['Branches', 'Tags', 'Open pull requests', 'Repository']);
    const current = inRepo({ currentPull: 12, currentRef: 'fix-ci' });
    expect(current[0].items[0]).toMatchObject({ detail: 'Current' });
    expect(
      current
        .find((section) => section.heading === 'Branches')
        ?.items.map((item) => item.detail)
    ).toEqual(['Default', undefined, 'Current']);
  });

  test('a typed number opens that pull, even one not in the open list', () => {
    // Number prefixes narrow the open list; refs aren't matched at all.
    expect(outline(inRepo({ query: '1' }))).toEqual([
      ['Go to', ['open-pull:1']],
      ['Open pull requests', ['pull:12']],
    ]);
    const sections = inRepo({ query: '#4512' });
    expect(sections[0]).toMatchObject({
      heading: 'Go to',
      items: [
        {
          label: 'Open #4512',
          action: { type: 'navigate', path: '/oven-sh/bun/pull/4512' },
        },
      ],
    });
  });

  test('text filters pull titles and refs, and any ref-shaped text still browses', () => {
    expect(outline(inRepo({ query: 'fix' }))).toEqual([
      ['Open pull requests', ['pull:7']],
      ['Branches', ['branch:fix-ci']],
      ['Browse', ['browse-ref:fix']],
    ]);
    expect(actionOf(inRepo({ query: 'fix' }), 'Branches')).toEqual({
      type: 'navigate',
      path: '/oven-sh/bun/tree/fix-ci',
      recordTitle: 'oven-sh/bun@fix-ci · files',
    });
  });

  test('after "@", digits match refs first, with the pull still offered', () => {
    const sections = inRepo({
      prefer: 'refs',
      query: '1234567',
      refs: { ...refs, tags: ['1234567-rc'] },
      refsFirst: true,
    });
    expect(outline(sections)).toEqual([
      ['Go to', ['commit:1234567']],
      ['Tags', ['tag:1234567-rc']],
      ['Browse', ['browse-ref:1234567']],
      ['Pull request', ['open-pull:1234567']],
    ]);
    // An explicit "#" is a pull even there.
    expect(
      outline(inRepo({ prefer: 'refs', query: '#12', refsFirst: true }))
    ).toEqual([
      ['Go to', ['open-pull:12']],
      ['Open pull requests', ['pull:12']],
    ]);
  });

  test('the repository row links to its scope on the pull dashboard', () => {
    const repository = inRepo({}).find(
      (section) => section.heading === 'Repository'
    );
    expect(repository?.items[1].action).toEqual({
      type: 'navigate',
      path: '/pulls?repo=oven-sh%2Fbun',
    });
  });

  test('a sha offers its commit diff and its tree', () => {
    const sections = inRepo({ query: 'abc1234' });
    expect(actionOf(sections, 'Go to')).toEqual({
      type: 'navigate',
      path: '/oven-sh/bun/commit/abc1234',
    });
    expect(actionOf(sections, 'Browse')).toMatchObject({
      path: '/oven-sh/bun/tree/abc1234',
    });
  });

  test('a pasted link opens what it names, not a ref of this repository', () => {
    expect(
      outline(inRepo({ query: 'https://github.com/oven-sh/bun/pull/12' }))
    ).toEqual([['Go to', ['open:/oven-sh/bun/pull/12']]]);
    expect(
      actionOf(
        inRepo({
          appHost: 'diffs.example',
          query: 'https://diffs.example/kclejeune/pierre/tree/main',
        }),
        'Go to'
      )
    ).toEqual({ type: 'navigate', path: '/kclejeune/pierre/tree/main' });
    // Path-shaped ref names still browse.
    expect(outline(inRepo({ query: 'release-1.2/hotfix' })).at(-1)).toEqual([
      'Browse',
      ['browse-ref:release-1.2/hotfix'],
    ]);
  });

  test('lists still loading leave the rest of the level usable', () => {
    expect(
      outline(inRepo({ pulls: null, refs: null })).map(([heading]) => heading)
    ).toEqual(['Repository']);
  });
});

describe('deriveRepoSearchQuery', () => {
  test('bare names may use any repository-name character', () => {
    expect(deriveRepoSearchQuery('my_repo')).toEqual({
      owner: null,
      query: 'my_repo',
    });
    expect(deriveRepoSearchQuery('acme/my_repo')).toEqual({
      owner: 'acme',
      query: 'my_repo',
    });
  });

  test('anything that cannot name a repository has no remote search', () => {
    expect(deriveRepoSearchQuery('two words')).toBeNull();
    expect(deriveRepoSearchQuery('https://github.com/a/b')).toBeNull();
    expect(deriveRepoSearchQuery('acme/widgets#12')).toBeNull();
    expect(deriveRepoSearchQuery('acme/widgets/pull/12')).toBeNull();
  });
});
