import { afterEach, describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { GET } from '../app/api/pull-conflicts/route';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const json = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  });

// Serves a pull whose only both-changed path is `link`, stubbing GitHub by
// request path (any GHES /api/v3 prefix stripped). `trees` lists the root
// tree of the merge base (`mb-tree`), head (`head-tree`), and base
// (`base-tree`); `blobs` and `contentsAtMergeBase` are what the blob and
// contents APIs return.
function stubGitHub({
  blobs,
  contentsAtMergeBase,
  mode,
}: {
  blobs: Record<string, string>;
  contentsAtMergeBase: string;
  mode: string;
}) {
  const entry = (sha: string) => ({ mode, path: 'link', sha, type: 'blob' });
  const trees: Record<string, unknown> = {
    'base-tree': { tree: [entry('base-blob')] },
    'head-tree': { tree: [entry('head-blob')] },
    'mb-tree': { tree: [entry('mb-blob')] },
  };
  globalThis.fetch = ((input: unknown) => {
    const path = new URL(String(input)).pathname.replace(/^\/api\/v3/, '');
    const routes: [RegExp, () => Response][] = [
      [
        /\/pulls\/1$/,
        () =>
          json({
            base: { ref: 'main', sha: 'base-sha' },
            head: { ref: 'feature', sha: 'head-sha' },
            mergeable: false,
          }),
      ],
      [/\/git\/ref\/heads\/main$/, () => json({ object: { sha: 'base-sha' } })],
      [/\/git\/commits\/head-sha$/, () => json({ tree: { sha: 'head-tree' } })],
      [
        /\/compare\/base-sha\.\.\.head-sha$/,
        () =>
          json({
            base_commit: { commit: { tree: { sha: 'base-tree' } } },
            files: [{ filename: 'link', sha: 'head-blob', status: 'modified' }],
            merge_base_commit: {
              commit: { tree: { sha: 'mb-tree' } },
              sha: 'mb-sha',
            },
          }),
      ],
      [
        /\/compare\/mb-sha\.\.\.base-sha$/,
        () =>
          json({
            files: [{ filename: 'link', sha: 'base-blob', status: 'modified' }],
          }),
      ],
      [
        /\/git\/trees\/([^/]+)$/,
        () => json(trees[/([^/]+)$/.exec(path)?.[1] ?? ''] ?? {}),
      ],
      [
        /\/git\/blobs\/([^/]+)$/,
        () => new Response(blobs[/([^/]+)$/.exec(path)?.[1] ?? ''] ?? ''),
      ],
      [/\/contents\/link$/, () => new Response(contentsAtMergeBase)],
    ];
    const route = routes.find(([pattern]) => pattern.test(path));
    return Promise.resolve(
      route == null ? new Response('Not Found', { status: 404 }) : route[1]()
    );
  }) as typeof fetch;
}

async function getConflicts(): Promise<{
  autoMerged: string[];
  files: { conflictCount: number; path: string }[];
}> {
  const response = await GET(
    new NextRequest(
      'https://diffshub.test/api/pull-conflicts?owner=acme&repo=widgets&pull=1'
    )
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    autoMerged: string[];
    files: { conflictCount: number; path: string }[];
  };
}

describe('pull-conflicts GET', () => {
  test('a symlink changed on both sides diffs link targets, not the old target file', async () => {
    // The contents API follows the merge-base symlink to the file it named;
    // that file happens to hold the head's new target path, which would make
    // diff3 see head as unchanged and silently take base's target.
    stubGitHub({
      blobs: {
        'base-blob': 'targets/base',
        'head-blob': 'targets/head',
        'mb-blob': 'targets/old',
      },
      contentsAtMergeBase: 'targets/head',
      mode: '120000',
    });
    const result = await getConflicts();
    expect(result.autoMerged).toEqual([]);
    expect(result.files.map((file) => file.path)).toEqual(['link']);
  });

  test('a regular file reads its merge base at the merge-base commit', async () => {
    stubGitHub({
      blobs: { 'base-blob': 'a\nb\nbase\n', 'head-blob': 'head\nb\nc\n' },
      contentsAtMergeBase: 'a\nb\nc\n',
      mode: '100644',
    });
    const result = await getConflicts();
    expect(result.autoMerged).toEqual(['link']);
    expect(result.files).toEqual([]);
  });
});
