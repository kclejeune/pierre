import { afterEach, describe, expect, test } from 'bun:test';

import { pullChangeKey, subscribePullChanges } from '@/lib/pullChangeEvents';
import { submitPullReview } from '@/lib/pullCommentsClient';
import { mergePullRequest } from '@/lib/pullMergeClient';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const pull = { number: '7', owner: 'Acme', repo: 'widgets' };

function answer(body: unknown, status = 200) {
  globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(Response.json(body, { status }))) as typeof fetch;
}

describe('pull change events', () => {
  test('a submitted review tells listeners its pull changed', async () => {
    const heard: string[] = [];
    const stop = subscribePullChanges((key) => heard.push(key));
    try {
      answer({});
      await submitPullReview(pull, 'token', 'APPROVE', '', []);
      expect(heard).toEqual([pullChangeKey(pull)]);
      expect(heard[0]).toBe('acme/widgets#7');
    } finally {
      stop();
    }
  });

  test('a failed review or an unmerged merge stays quiet', async () => {
    const heard: string[] = [];
    const stop = subscribePullChanges((key) => heard.push(key));
    try {
      answer({ error: 'nope' }, 422);
      const failed = await submitPullReview(
        pull,
        'token',
        'APPROVE',
        '',
        []
      ).then(
        () => false,
        () => true
      );
      expect(failed).toBe(true);
      answer({ merged: false, message: 'Base branch was modified' });
      await mergePullRequest(pull, 'token', 'squash');
      expect(heard).toEqual([]);
      answer({ merged: true });
      await mergePullRequest(pull, 'token', 'squash');
      expect(heard).toEqual(['acme/widgets#7']);
    } finally {
      stop();
    }
  });
});
