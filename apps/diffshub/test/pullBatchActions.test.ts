import { describe, expect, spyOn, test } from 'bun:test';

import type { PullSummary } from '@/lib/githubPullSummaries';
import { runPullBatch } from '@/lib/pullBatchActions';

function pull(repo: string): PullSummary {
  return {
    number: 4,
    owner: 'acme',
    repo,
    state: 'open',
    title: 'bump',
    updatedAt: '2026-11-18T00:00:00Z',
    viewerPath: `/acme/${repo}/pull/4`,
  };
}

// Routes each client call to a canned response: pull-info gives the head,
// pull-details whether the base branch has a merge queue.
function mockRoutes(options: {
  // Bases with a merge queue, and pulls already in one.
  queued?: string[];
  inQueue?: string[];
  failApprove?: string[];
}) {
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  const spy = spyOn(globalThis, 'fetch').mockImplementation(((
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
    const url = new URL(String(input), 'https://diffshub.test');
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    const repo = String(body?.repo ?? url.searchParams.get('repo'));
    calls.push({ path: url.pathname, body });
    switch (url.pathname) {
      case '/api/pull-info':
        return Promise.resolve(Response.json({ headSha: `sha-${repo}` }));
      case '/api/pull-details':
        return Promise.resolve(
          Response.json({
            mergeCapabilities: { canMerge: true, methods: ['squash', 'merge'] },
            mergeQueue: (options.inQueue ?? []).includes(repo)
              ? {
                  entry: { position: 1, state: 'QUEUED' },
                  pendingAutoMerge: false,
                }
              : (options.queued ?? []).includes(repo)
                ? { entry: null, pendingAutoMerge: false }
                : null,
          })
        );
      case '/api/pull-comments':
        return Promise.resolve(
          (options.failApprove ?? []).includes(repo)
            ? Response.json(
                { error: 'Can not approve your own pull request' },
                { status: 422 }
              )
            : Response.json({ review: null })
        );
      case '/api/pull-merge':
        return Promise.resolve(Response.json({ merged: true }));
      case '/api/pull-merge-queue':
        return Promise.resolve(Response.json({ mergeQueue: null }));
    }
    return Promise.resolve(Response.json({}, { status: 404 }));
  }) as typeof fetch);
  return { calls, restore: () => spy.mockRestore() };
}

describe('runPullBatch', () => {
  test('approves each pull pinned to its current head, collecting failures', async () => {
    const routes = mockRoutes({ failApprove: ['b'] });
    try {
      const settled: number[] = [];
      const result = await runPullBatch(
        [pull('a'), pull('b'), pull('c')],
        'approve',
        'ghu_token',
        (done) => settled.push(done)
      );
      expect(result.succeeded).toBe(2);
      expect(result.failures.map((failure) => failure.pull.repo)).toEqual([
        'b',
      ]);
      expect(settled).toEqual([1, 2, 3]);
      const reviews = routes.calls.filter(
        (call) => call.path === '/api/pull-comments'
      );
      expect(
        reviews.map((call) => [
          call.body?.repo,
          call.body?.event,
          call.body?.commitId,
        ])
      ).toContainEqual(['a', 'APPROVE', 'sha-a']);
    } finally {
      routes.restore();
    }
  });

  test('refuses when the head moved past the commit on screen', async () => {
    const routes = mockRoutes({});
    try {
      const approve = await runPullBatch(
        [pull('a')],
        'approve',
        'ghu_token',
        undefined,
        'sha-old'
      );
      const merge = await runPullBatch(
        [pull('a')],
        'merge',
        'ghu_token',
        undefined,
        'sha-old'
      );
      expect(approve.succeeded).toBe(0);
      expect(approve.failures[0]?.message).toContain('New commits');
      expect(merge.succeeded).toBe(0);
      expect(
        routes.calls.some(
          (call) =>
            call.path === '/api/pull-comments' ||
            call.path === '/api/pull-merge'
        )
      ).toBe(false);
      // The head it expects goes through.
      const pinned = await runPullBatch(
        [pull('a')],
        'approve',
        'ghu_token',
        undefined,
        'sha-a'
      );
      expect(pinned.succeeded).toBe(1);
    } finally {
      routes.restore();
    }
  });

  test('queues where there is a merge queue, merges with the default method elsewhere', async () => {
    const routes = mockRoutes({ queued: ['q'] });
    try {
      const result = await runPullBatch(
        [pull('q'), pull('m')],
        'merge',
        'ghu_token'
      );
      expect(result).toEqual({ failures: [], succeeded: 2 });
      const queue = routes.calls.find(
        (call) => call.path === '/api/pull-merge-queue'
      );
      expect(queue?.body).toMatchObject({
        action: 'enqueue',
        expectedHeadSha: 'sha-q',
        repo: 'q',
      });
      const merge = routes.calls.find(
        (call) => call.path === '/api/pull-merge'
      );
      expect(merge?.body).toMatchObject({
        expectedHeadSha: 'sha-m',
        method: 'squash',
        repo: 'm',
      });
    } finally {
      routes.restore();
    }
  });

  test('a pull already in the merge queue counts as done without re-enqueuing', async () => {
    const routes = mockRoutes({ inQueue: ['q'] });
    try {
      const result = await runPullBatch([pull('q')], 'merge', 'ghu_token');
      expect(result).toEqual({ failures: [], succeeded: 1 });
      expect(
        routes.calls.some((call) => call.path === '/api/pull-merge-queue')
      ).toBe(false);
    } finally {
      routes.restore();
    }
  });
});
