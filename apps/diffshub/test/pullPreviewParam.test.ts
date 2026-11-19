import { describe, expect, test } from 'bun:test';

import { pullKey } from '@/lib/githubPullSummaries';
import {
  readPreviewPullKey,
  readPullsPageState,
  writePreviewPull,
  writePullsPageState,
} from '@/lib/pullScopes';

describe('previewed pull URL param', () => {
  const pull = { number: 56, owner: 'acme', repo: 'widgets' };

  test('round-trips to the same key the list rows use', () => {
    const url = writePreviewPull(
      new URL('https://x.test/pulls?q=is%3Aopen'),
      pull
    );
    expect(url.searchParams.get('pull')).toBe('acme/widgets/56');
    expect(url.searchParams.get('q')).toBe('is:open');
    expect(readPreviewPullKey(url.search)).toBe(pullKey(pull));
  });

  test('null removes it', () => {
    const url = writePreviewPull(
      new URL('https://x.test/pulls?pull=acme/widgets/56'),
      null
    );
    expect(url.search).toBe('');
  });

  test('malformed values read as no preview', () => {
    for (const value of ['', 'acme/widgets', 'acme/widgets/x', '56']) {
      expect(
        readPreviewPullKey(`?pull=${encodeURIComponent(value)}`)
      ).toBeNull();
    }
  });

  test('page-state writes leave it in place and do not read it', () => {
    const url = new URL('https://x.test/pulls?pull=acme/widgets/56');
    const state = readPullsPageState(url.search);
    const written = writePullsPageState(url, { ...state, text: 'is:merged' });
    expect(written.searchParams.get('pull')).toBe('acme/widgets/56');
    expect(written.searchParams.get('q')).toBe('is:merged');
  });
});
