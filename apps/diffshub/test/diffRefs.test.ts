import { describe, expect, test } from 'bun:test';

import { describeDiffRefs } from '../lib/diffRefs';
import type { PullInfo } from '../lib/pullInfoClient';

const repo = { owner: 'acme', repo: 'widgets' };

function pullInfo(overrides: Partial<PullInfo> = {}): PullInfo {
  return {
    baseRef: 'main',
    baseRepo: repo,
    baseSha: 'a'.repeat(40),
    headRef: 'feat/thing',
    headRepo: repo,
    headSha: 'b'.repeat(40),
    number: '42',
    ...overrides,
  };
}

describe('describeDiffRefs', () => {
  test('commits have no base/head pair', () => {
    expect(
      describeDiffRefs({ kind: 'commit', repo, sha: 'deadbeef' }, null)
    ).toBeNull();
  });

  test('three-dot compare ranges name both ends', () => {
    expect(
      describeDiffRefs(
        { kind: 'compare', range: 'main...feat/thing', repo },
        null
      )
    ).toEqual({
      base: { browsePath: '/acme/widgets/tree/main', label: 'main' },
      head: {
        browsePath: '/acme/widgets/tree/feat/thing',
        label: 'feat/thing',
      },
    });
  });

  test('two-dot ranges and tags split the same way', () => {
    expect(
      describeDiffRefs({ kind: 'compare', range: 'v6.0..v7.0', repo }, null)
    ).toEqual({
      base: { browsePath: '/acme/widgets/tree/v6.0', label: 'v6.0' },
      head: { browsePath: '/acme/widgets/tree/v7.0', label: 'v7.0' },
    });
  });

  test('fork ends keep the owner:branch label without a browse path', () => {
    expect(
      describeDiffRefs(
        { kind: 'compare', range: 'main...forker:topic', repo },
        null
      )
    ).toEqual({
      base: { browsePath: '/acme/widgets/tree/main', label: 'main' },
      head: { browsePath: null, label: 'forker:topic' },
    });
  });

  test('a bare compare ref is a head against the default branch', () => {
    expect(
      describeDiffRefs({ kind: 'compare', range: 'topic', repo }, null)
    ).toEqual({
      base: null,
      head: { browsePath: '/acme/widgets/tree/topic', label: 'topic' },
    });
  });

  test('pulls wait for their metadata', () => {
    expect(
      describeDiffRefs({ kind: 'pull', number: '42', repo }, null)
    ).toBeNull();
    // Metadata for a different pull (a stale fetch after navigation) does not
    // label this one.
    expect(
      describeDiffRefs(
        { kind: 'pull', number: '43', repo },
        pullInfo({ number: '42' })
      )
    ).toBeNull();
  });

  test('same-repo pulls label head and base branches', () => {
    expect(
      describeDiffRefs({ kind: 'pull', number: '42', repo }, pullInfo())
    ).toEqual({
      base: { browsePath: '/acme/widgets/tree/main', label: 'main' },
      head: {
        browsePath: '/acme/widgets/tree/refs/pull/42/head',
        label: 'feat/thing',
      },
    });
  });

  test('fork pulls spell the head as owner:branch', () => {
    const refs = describeDiffRefs(
      { kind: 'pull', number: '42', repo },
      pullInfo({
        headRef: 'topic',
        headRepo: { owner: 'forker', repo: 'widgets' },
        headSha: 'c'.repeat(40),
      })
    );
    expect(refs?.head.label).toBe('forker:topic');
    // The base repo still advertises the pull head, so it stays browsable.
    expect(refs?.head.browsePath).toBe('/acme/widgets/tree/refs/pull/42/head');
  });
});
