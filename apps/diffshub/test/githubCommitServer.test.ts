import { describe, expect, test } from 'bun:test';

import {
  createBlob,
  createCommit,
  createTree,
  createTreeEntryResolver,
  fetchBranchTipSha,
  GitHubCommitError,
  updateRef,
  waitForPullHead,
} from '@/lib/githubCommitServer';

const REPO = { owner: 'acme', repo: 'widgets' };

interface RecordedRequest {
  body: unknown;
  method: string;
  url: string;
}

// Fetch stub that records each request and replays canned JSON responses in
// order (or keyed by URL substring via a matcher function).
function createFetchStub(
  respond: (url: string, init?: RequestInit) => Response
) {
  const requests: RecordedRequest[] = [];
  const fetcher = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      body: init?.body == null ? undefined : JSON.parse(String(init.body)),
      method: init?.method ?? 'GET',
      url,
    });
    return respond(url, init);
  }) as typeof fetch;
  return { fetcher, requests };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status });
}

describe('git data writes', () => {
  test('createBlob posts utf-8 contents and returns the sha', async () => {
    const { fetcher, requests } = createFetchStub(() =>
      jsonResponse({ sha: 'blob1' })
    );
    const sha = await createBlob(REPO, 'tok', 'hello\n', fetcher);
    expect(sha).toBe('blob1');
    expect(requests[0]?.url).toContain('/repos/acme/widgets/git/blobs');
    expect(requests[0]?.body).toEqual({
      content: 'hello\n',
      encoding: 'utf-8',
    });
  });

  test('createTree sends base_tree and null-sha deletions', async () => {
    const { fetcher, requests } = createFetchStub(() =>
      jsonResponse({ sha: 'tree1' })
    );
    await createTree(
      REPO,
      'tok',
      'base-tree',
      [
        { mode: '100755', path: 'bin/run', sha: 'blob1' },
        { mode: '100644', path: 'gone.txt', sha: null },
      ],
      fetcher
    );
    expect(requests[0]?.body).toEqual({
      base_tree: 'base-tree',
      tree: [
        { mode: '100755', path: 'bin/run', sha: 'blob1', type: 'blob' },
        { mode: '100644', path: 'gone.txt', sha: null, type: 'blob' },
      ],
    });
  });

  test('createCommit carries message, tree, and parents', async () => {
    const { fetcher, requests } = createFetchStub(() =>
      jsonResponse({ sha: 'commit1' })
    );
    const commit = await createCommit(
      REPO,
      'tok',
      { message: 'Merge it', parents: ['head1', 'base1'], treeSha: 'tree1' },
      fetcher
    );
    expect(commit).toBe('commit1');
    expect(requests[0]?.body).toEqual({
      message: 'Merge it',
      parents: ['head1', 'base1'],
      tree: 'tree1',
    });
  });

  test('updateRef patches the branch without force', async () => {
    const { fetcher, requests } = createFetchStub(() =>
      jsonResponse({ ref: 'refs/heads/feature' })
    );
    await updateRef(REPO, 'tok', 'feature/nested', 'commit1', fetcher);
    expect(requests[0]?.method).toBe('PATCH');
    expect(requests[0]?.url).toContain('/git/refs/heads/feature/nested');
    expect(requests[0]?.body).toEqual({ force: false, sha: 'commit1' });
  });

  test('maps GitHub write failures onto actionable codes', async () => {
    const cases: [number, string, string][] = [
      [422, 'Update is not a fast forward', 'stale-head'],
      [422, 'Required status check on protected branch', 'protected-branch'],
      [403, 'Resource not accessible by integration', 'forbidden'],
      [500, 'boom', 'github'],
    ];
    for (const [status, detail, code] of cases) {
      const { fetcher } = createFetchStub(
        () => new Response(detail, { status })
      );
      const error = await updateRef(REPO, 'tok', 'main', 'sha', fetcher).catch(
        (thrown: unknown) => thrown
      );
      expect(error).toBeInstanceOf(GitHubCommitError);
      expect((error as GitHubCommitError).code).toBe(
        code as GitHubCommitError['code']
      );
    }
  });
});

describe('createTreeEntryResolver', () => {
  const TREES: Record<string, unknown> = {
    root: {
      tree: [
        { mode: '040000', path: 'src', sha: 'src-tree', type: 'tree' },
        { mode: '100644', path: 'README.md', sha: 'readme', type: 'blob' },
      ],
    },
    'src-tree': {
      tree: [{ mode: '100755', path: 'run.sh', sha: 'runsh', type: 'blob' }],
    },
  };

  function treeFetchStub() {
    return createFetchStub((url) => {
      const sha = /\/git\/trees\/([^/?]+)/.exec(url)?.[1];
      const payload = sha == null ? undefined : TREES[sha];
      return payload == null
        ? new Response('Not Found', { status: 404 })
        : jsonResponse(payload);
    });
  }

  test('walks nested paths and preserves the mode', async () => {
    const { fetcher } = treeFetchStub();
    const resolve = createTreeEntryResolver(REPO, 'tok', fetcher);
    expect(await resolve('root', 'src/run.sh')).toEqual({
      mode: '100755',
      sha: 'runsh',
    });
    expect(await resolve('root', 'README.md')).toEqual({
      mode: '100644',
      sha: 'readme',
    });
  });

  test('returns null for missing paths and non-blob hits', async () => {
    const { fetcher } = treeFetchStub();
    const resolve = createTreeEntryResolver(REPO, 'tok', fetcher);
    expect(await resolve('root', 'src/missing.ts')).toBeNull();
    expect(await resolve('root', 'src')).toBeNull();
  });

  test('memoizes directory listings across resolutions', async () => {
    const { fetcher, requests } = treeFetchStub();
    const resolve = createTreeEntryResolver(REPO, 'tok', fetcher);
    await resolve('root', 'src/run.sh');
    await resolve('root', 'README.md');
    await resolve('root', 'src/other.ts');
    // root and src each listed exactly once despite three resolutions.
    expect(requests).toHaveLength(2);
  });
});

describe('fetchBranchTipSha', () => {
  test('reads the live tip from git/ref/heads, keeping slashes in the name', async () => {
    const { fetcher, requests } = createFetchStub(() =>
      jsonResponse({ object: { sha: 'live', type: 'commit' } })
    );
    expect(
      await fetchBranchTipSha(REPO, 'release/2026-08', 'tok', fetcher)
    ).toBe('live');
    expect(requests[0]?.url).toContain(
      '/repos/acme/widgets/git/ref/heads/release/2026-08'
    );
  });

  test('throws a 502 GitHubCommitError when the payload lacks a sha', async () => {
    const { fetcher } = createFetchStub(() => jsonResponse({}));
    let caught: unknown;
    try {
      await fetchBranchTipSha(REPO, 'main', undefined, fetcher);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GitHubCommitError);
    expect((caught as GitHubCommitError).status).toBe(502);
  });
});

describe('waitForPullHead', () => {
  test('polls until the pull reports the new head and computed mergeability', async () => {
    const payloads = [
      { head: { sha: 'old' }, mergeable: false },
      { head: { sha: 'new' }, mergeable: null },
      { head: { sha: 'new' }, mergeable: true },
      { head: { sha: 'new' }, mergeable: true },
    ];
    let index = 0;
    const { fetcher, requests } = createFetchStub(() =>
      jsonResponse(payloads[index++])
    );
    await waitForPullHead(
      REPO,
      '7',
      'new',
      'tok',
      { intervalMs: 0, maxAttempts: 10 },
      fetcher
    );
    expect(requests).toHaveLength(3);
    expect(requests[0]?.url).toContain('/repos/acme/widgets/pulls/7');
  });

  test('gives up after maxAttempts and on request failure', async () => {
    const stale = createFetchStub(() =>
      jsonResponse({ head: { sha: 'old' }, mergeable: true })
    );
    await waitForPullHead(
      REPO,
      '7',
      'new',
      'tok',
      { intervalMs: 0, maxAttempts: 3 },
      stale.fetcher
    );
    expect(stale.requests).toHaveLength(3);

    const failing = createFetchStub(
      () => new Response('nope', { status: 500 })
    );
    await waitForPullHead(
      REPO,
      '7',
      'new',
      'tok',
      { intervalMs: 0, maxAttempts: 3 },
      failing.fetcher
    );
    expect(failing.requests).toHaveLength(1);
  });
});
