import { describe, expect, test } from 'bun:test';

import { createTreeLister, GitHubCommitError } from '@/lib/githubCommitServer';
import { diffTrees } from '@/lib/gitTreeDiff';
import { type PlainFetch } from '@/lib/plainFetch';

const REPO = { owner: 'acme', repo: 'widgets' };

type Entry = { mode: string; path: string; sha: string; type: string };
const blob = (path: string, sha: string, mode = '100644'): Entry => ({
  mode,
  path,
  sha,
  type: 'blob',
});
const tree = (path: string, sha: string): Entry => ({
  mode: '040000',
  path,
  sha,
  type: 'tree',
});

// Serves `/git/trees/<sha>` from a fixture map and records which trees were
// listed, so tests can assert that unchanged subtrees are never fetched.
function treeFetcher(trees: Record<string, Entry[] | { truncated: true }>) {
  const listed: string[] = [];
  const fetcher: PlainFetch = (input) => {
    const sha = /\/git\/trees\/([^/?]+)/.exec(String(input))?.[1] ?? '';
    listed.push(sha);
    const fixture = trees[sha];
    if (fixture == null) {
      return Promise.resolve(
        new Response('{"message":"Not Found"}', { status: 404 })
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify(Array.isArray(fixture) ? { tree: fixture } : fixture)
      )
    );
  };
  return { fetcher, listed };
}

describe('diffTrees', () => {
  // `shared` is identical on both sides; `src` differs.
  const TREES = {
    left: [
      tree('shared', 'shared-tree'),
      tree('src', 'src-left'),
      blob('README.md', 'readme-1'),
      blob('gone.txt', 'gone'),
    ],
    right: [
      tree('shared', 'shared-tree'),
      tree('src', 'src-right'),
      blob('README.md', 'readme-2'),
      blob('new.txt', 'new'),
    ],
    'src-left': [
      blob('a.ts', 'a-1'),
      blob('same.ts', 'same'),
      blob('run.sh', 'run', '100644'),
      blob('link', 'link-target', '120000'),
    ],
    'src-right': [
      blob('a.ts', 'a-2'),
      blob('same.ts', 'same'),
      blob('run.sh', 'run', '100755'),
      blob('link', 'link-target', '100644'),
    ],
    'shared-tree': [blob('big.bin', 'big')],
  };

  test('reports added, removed, modified, and type-changed files', async () => {
    const { fetcher, listed } = treeFetcher(TREES);
    const changes = await diffTrees(
      createTreeLister(REPO, 'tok', fetcher),
      'left',
      'right'
    );
    expect(changes).toEqual([
      // Each surviving file carries its right-side blob SHA.
      { filename: 'README.md', sha: 'readme-2', status: 'modified' },
      { filename: 'gone.txt', status: 'removed' },
      { filename: 'new.txt', sha: 'new', status: 'added' },
      { filename: 'src/a.ts', sha: 'a-2', status: 'modified' },
      { filename: 'src/link', sha: 'link-target', status: 'changed' },
      // An executable-bit flip is a mode change on a regular file.
      { filename: 'src/run.sh', sha: 'run', status: 'modified' },
    ]);
    // The identical `shared` subtree is skipped without being listed.
    expect(listed).not.toContain('shared-tree');
  });

  test('identical roots need no requests', async () => {
    const { fetcher, listed } = treeFetcher(TREES);
    const lister = createTreeLister(REPO, 'tok', fetcher);
    expect(await diffTrees(lister, 'left', 'left')).toEqual([]);
    expect(listed).toEqual([]);
  });

  test('a path filter only compares those files and their directories', async () => {
    const { fetcher, listed } = treeFetcher({
      ...TREES,
      left: [...TREES.left, tree('docs', 'docs-left')],
      right: [...TREES.right, tree('docs', 'docs-right')],
    });
    const changes = await diffTrees(
      createTreeLister(REPO, 'tok', fetcher),
      'left',
      'right',
      ['src/a.ts', 'new.txt', 'missing/everywhere.ts']
    );
    expect(changes).toEqual([
      { filename: 'new.txt', sha: 'new', status: 'added' },
      { filename: 'src/a.ts', sha: 'a-2', status: 'modified' },
    ]);
    // `docs` differs but holds no wanted path, so it is never listed.
    expect(listed).not.toContain('docs-left');
    expect(listed).not.toContain('docs-right');
  });

  test('a file replaced by a directory reports both sides', async () => {
    const { fetcher } = treeFetcher({
      left: [blob('config', 'config-file')],
      right: [tree('config', 'config-dir')],
      'config-dir': [blob('main.json', 'main')],
    });
    expect(
      await diffTrees(createTreeLister(REPO, 'tok', fetcher), 'left', 'right')
    ).toEqual([
      { filename: 'config', status: 'removed' },
      { filename: 'config/main.json', sha: 'main', status: 'added' },
    ]);
  });

  test('directories present on one side only are walked in full', async () => {
    const { fetcher } = treeFetcher({
      left: [],
      right: [tree('pkg', 'pkg-tree')],
      'pkg-tree': [blob('index.ts', 'index'), tree('lib', 'lib-tree')],
      'lib-tree': [blob('util.ts', 'util')],
    });
    expect(
      await diffTrees(createTreeLister(REPO, 'tok', fetcher), 'left', 'right')
    ).toEqual([
      { filename: 'pkg/index.ts', sha: 'index', status: 'added' },
      { filename: 'pkg/lib/util.ts', sha: 'util', status: 'added' },
    ]);
  });

  test('the lister fetches each tree SHA once across walks', async () => {
    const { fetcher, listed } = treeFetcher(TREES);
    const lister = createTreeLister(REPO, 'tok', fetcher);
    await diffTrees(lister, 'left', 'right');
    await diffTrees(lister, 'right', 'left');
    expect(listed.filter((sha) => sha === 'src-left')).toHaveLength(1);
  });

  test('a truncated tree listing refuses rather than guessing', async () => {
    const { fetcher } = treeFetcher({
      left: [tree('huge', 'huge-left')],
      right: [tree('huge', 'huge-right')],
      'huge-left': { truncated: true },
      'huge-right': [],
    });
    const error = await diffTrees(
      createTreeLister(REPO, 'tok', fetcher),
      'left',
      'right'
    ).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GitHubCommitError);
  });
});
