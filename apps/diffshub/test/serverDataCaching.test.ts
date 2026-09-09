import {
  afterEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from 'bun:test';
import { createHash } from 'node:crypto';

import {
  clearGitHubDiffFileServerCache,
  loadGitHubDiffFiles,
} from '../lib/githubDiffFileServer';
import {
  clearGitHubRepoBrowserServerCache,
  loadRepoBrowserTree,
} from '../lib/githubRepoBrowserServer';
import type { PlainFetch } from '../lib/plainFetch';

const originalFetch = globalThis.fetch;
const repo = { owner: 'acme', repo: 'widgets' };

function requestURL(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof Request) {
    return new URL(input.url);
  }
  return new URL(input.toString());
}

function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error
  );
}

afterEach(() => {
  setSystemTime();
  globalThis.fetch = originalFetch;
  clearGitHubDiffFileServerCache();
  clearGitHubRepoBrowserServerCache();
});

describe('repository tree server caching', () => {
  test('partitions credentials and shares trees by resolved commit', async () => {
    const sha = 'a'.repeat(40);
    const requests: { authorization: string | null; path: string }[] = [];
    globalThis.fetch = mock((input, init) => {
      const url = requestURL(input);
      requests.push({
        authorization: new Headers(init?.headers).get('authorization'),
        path: url.pathname,
      });
      if (url.pathname.includes('/commits/')) {
        return Promise.resolve(new Response(sha));
      }
      if (url.pathname.includes('/git/trees/')) {
        return Promise.resolve(
          Response.json({
            tree: [{ path: 'src/index.ts', type: 'blob' }],
            truncated: false,
          })
        );
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch;

    const first = await loadRepoBrowserTree(repo, 'main', { token: 'one' });
    const repeated = await loadRepoBrowserTree(repo, 'main', { token: 'one' });
    const alias = await loadRepoBrowserTree(repo, 'stable', { token: 'one' });
    await loadRepoBrowserTree(repo, 'main', { token: 'two' });
    const pinned = await loadRepoBrowserTree(repo, sha, { token: 'one' });

    expect(first).toEqual(repeated);
    expect(alias.sha).toBe(sha);
    expect(pinned.sha).toBe(sha);
    expect(
      requests.filter(({ path }) => path.includes('/commits/'))
    ).toHaveLength(4);
    expect(
      requests.filter(({ path }) => path.includes('/git/trees/'))
    ).toHaveLength(2);
    expect(new Set(requests.map(({ authorization }) => authorization))).toEqual(
      new Set(['Bearer one', 'Bearer two'])
    );
  });

  test('rechecks access to a full commit SHA after the target cache expires', async () => {
    const sha = 'a'.repeat(40);
    let revoked = false;
    let treeRequests = 0;
    globalThis.fetch = mock((input) => {
      const url = requestURL(input);
      if (url.pathname.includes('/commits/')) {
        return Promise.resolve(
          revoked
            ? new Response('Not Found', { status: 404 })
            : new Response(sha)
        );
      }
      if (url.pathname.includes('/git/trees/')) {
        treeRequests += 1;
        return Promise.resolve(
          Response.json({
            tree: [{ path: 'private/path.ts', type: 'blob' }],
            truncated: false,
          })
        );
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as unknown as typeof fetch;

    setSystemTime(new Date('2026-09-08T12:00:00Z'));
    await loadRepoBrowserTree(repo, sha, { token: 'revoked-later' });
    expect(treeRequests).toBe(1);

    setSystemTime(new Date('2026-09-08T12:01:01Z'));
    revoked = true;
    const error = await rejectionOf(
      loadRepoBrowserTree(repo, sha, { token: 'revoked-later' })
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('did not resolve to a commit');
    expect(treeRequests).toBe(1);
  });
});

describe('diff file server caching', () => {
  test('shares files by resolved commit only within one credential scope', async () => {
    const parentSha = '1'.repeat(40);
    const resolvedSha = '2'.repeat(40);
    const requests: { authorization: string | null; path: string }[] = [];
    const fetcher = mock((input, init) => {
      const url = requestURL(input);
      requests.push({
        authorization: new Headers(init?.headers).get('authorization'),
        path: `${url.pathname}${url.search}`,
      });
      if (url.pathname.includes('/commits/')) {
        return Promise.resolve(
          Response.json({
            parents: [{ sha: parentSha }],
            sha: resolvedSha,
          })
        );
      }
      if (url.pathname.includes('/contents/')) {
        return Promise.resolve(
          new Response(`contents at ${url.searchParams.get('ref')}`)
        );
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as PlainFetch;
    const request = {
      name: 'src/index.ts',
      path: '/acme/widgets/commit/aaaa',
      type: 'change' as const,
    };

    const first = await loadGitHubDiffFiles(request, {
      fetch: fetcher,
      token: 'one',
      tokenFromRequest: true,
    });
    const alias = await loadGitHubDiffFiles(
      { ...request, path: '/acme/widgets/commit/bbbb' },
      { fetch: fetcher, token: 'one', tokenFromRequest: true }
    );
    await loadGitHubDiffFiles(request, {
      fetch: fetcher,
      token: 'two',
      tokenFromRequest: true,
    });

    expect(first).toEqual(alias);
    expect(
      requests.filter(({ path }) => path.includes('/commits/'))
    ).toHaveLength(3);
    expect(
      requests.filter(({ path }) => path.includes('/contents/'))
    ).toHaveLength(4);
    expect(new Set(requests.map(({ authorization }) => authorization))).toEqual(
      new Set(['Bearer one', 'Bearer two'])
    );
  });
});

// The git object ID of a blob, matching what a patch's `index` line records.
function gitBlobId(contents: string): string {
  const bytes = Buffer.from(contents, 'utf8');
  return createHash('sha1')
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest('hex');
}

describe('diff file hydration against moved refs', () => {
  // Resolves to `shas[0]`, then `shas[1]`, and serves each ref's contents as
  // `contents at <ref>` so a test can tell which resolution a file came from.
  function createMovingRefFetcher(shas: string[]) {
    const resolvedShas: string[] = [];
    const fetcher = mock((input) => {
      const url = requestURL(input);
      if (url.pathname.includes('/commits/')) {
        const sha = shas[Math.min(resolvedShas.length, shas.length - 1)];
        resolvedShas.push(sha);
        return Promise.resolve(
          Response.json({ parents: [{ sha: '1'.repeat(40) }], sha })
        );
      }
      if (url.pathname.includes('/contents/')) {
        return Promise.resolve(
          new Response(`contents at ${url.searchParams.get('ref')}`)
        );
      }
      throw new Error(`Unexpected GitHub request: ${url}`);
    }) as PlainFetch;
    return { fetcher, resolvedShas };
  }

  const request = {
    name: 'src/index.ts',
    path: '/acme/widgets/commit/aaaa',
    type: 'change' as const,
  };

  test('re-resolves cached refs when the patch records different content', async () => {
    const staleSha = '2'.repeat(40);
    const freshSha = '3'.repeat(40);
    const { fetcher, resolvedShas } = createMovingRefFetcher([
      staleSha,
      freshSha,
    ]);
    const options = {
      fetch: fetcher,
      token: 'one',
      tokenFromRequest: true,
    };

    // Warms the ref cache with the resolution that is about to go stale.
    const stale = await loadGitHubDiffFiles(request, options);
    expect(stale.newFile?.contents).toBe(`contents at ${staleSha}`);

    const fresh = await loadGitHubDiffFiles(
      { ...request, newObjectId: gitBlobId(`contents at ${freshSha}`) },
      options
    );

    expect(fresh.newFile?.contents).toBe(`contents at ${freshSha}`);
    expect(resolvedShas).toEqual([staleSha, freshSha]);
  });

  test('rejects a freshly resolved ref when the recorded object ID does not match', async () => {
    const sha = '4'.repeat(40);
    const { fetcher, resolvedShas } = createMovingRefFetcher([sha]);

    const error = await rejectionOf(
      loadGitHubDiffFiles(
        { ...request, newObjectId: gitBlobId('something else entirely') },
        { fetch: fetcher, token: 'one', tokenFromRequest: true }
      )
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('The diff changed');

    expect(resolvedShas).toEqual([sha]);
  });

  test('rejects when a refreshed cached ref still does not match', async () => {
    const staleSha = '6'.repeat(40);
    const freshSha = '7'.repeat(40);
    const { fetcher, resolvedShas } = createMovingRefFetcher([
      staleSha,
      freshSha,
    ]);
    const options = {
      fetch: fetcher,
      token: 'one',
      tokenFromRequest: true,
    };

    await loadGitHubDiffFiles(request, options);
    const error = await rejectionOf(
      loadGitHubDiffFiles(
        { ...request, newObjectId: gitBlobId('neither cached revision') },
        options
      )
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('The diff changed');

    expect(resolvedShas).toEqual([staleSha, freshSha]);
  });

  test('ignores an abbreviated object ID too short to be meaningful', async () => {
    const sha = '5'.repeat(40);
    const { fetcher, resolvedShas } = createMovingRefFetcher([sha, sha]);
    const options = {
      fetch: fetcher,
      token: 'one',
      tokenFromRequest: true,
    };

    await loadGitHubDiffFiles(request, options);
    await loadGitHubDiffFiles({ ...request, newObjectId: 'abc' }, options);

    expect(resolvedShas).toEqual([sha]);
  });
});
