import { describe, expect, test } from 'bun:test';

import {
  fetchPullChecks,
  fetchPullReviewStates,
  foldReviewStates,
  normalizeCheckRun,
  normalizeCommitStatus,
  parsePullDetails,
  parsePullMergeCapabilities,
} from '../githubPullDetailsServer';
import type { PlainFetch } from '../plainFetch';
import { mergePullReviewers } from '../pullInfoClient';

describe('parsePullDetails', () => {
  test('extracts display metadata from a pulls/{n} payload', () => {
    const details = parsePullDetails({
      body: 'Fixes things.',
      draft: false,
      labels: [{ color: 'ff0000', name: 'bug' }, { name: 'no-color' }],
      mergeable: true,
      mergeable_state: 'clean',
      merged_at: null,
      requested_reviewers: [
        { avatar_url: 'https://a/o.png', login: 'octocat' },
      ],
      requested_teams: [{ slug: 'core-team' }],
      state: 'open',
      title: 'Fix the thing',
      user: { login: 'author' },
    });
    expect(details.title).toBe('Fix the thing');
    expect(details.body).toBe('Fixes things.');
    expect(details.authorLogin).toBe('author');
    expect(details.draft).toBe(false);
    expect(details.state).toBe('open');
    expect(details.mergeable).toBe(true);
    expect(details.mergeableState).toBe('clean');
    expect(details.labels).toEqual([
      { color: 'ff0000', name: 'bug' },
      { color: '', name: 'no-color' },
    ]);
    expect(details.reviewers).toEqual([
      { avatarUrl: 'https://a/o.png', login: 'octocat', state: 'PENDING' },
      { avatarUrl: undefined, login: 'core-team', state: 'PENDING' },
    ]);
  });

  test('merged_at wins over state, and a null body becomes empty', () => {
    const details = parsePullDetails({
      body: null,
      merged_at: '2026-01-01T00:00:00Z',
      state: 'closed',
    });
    expect(details.state).toBe('merged');
    expect(details.body).toBe('');
    expect(details.mergeable).toBeNull();
  });

  test('tolerates a malformed payload', () => {
    const details = parsePullDetails(null);
    expect(details.title).toBe('');
    expect(details.labels).toEqual([]);
    expect(details.reviewers).toEqual([]);
    expect(details.state).toBe('open');
  });
});

describe('foldReviewStates', () => {
  test('keeps the latest verdict per reviewer, skipping PENDING', () => {
    const states = foldReviewStates([
      { state: 'CHANGES_REQUESTED', user: { login: 'a' } },
      { state: 'COMMENTED', user: { login: 'a' } },
      { state: 'APPROVED', user: { login: 'a' } },
      { state: 'COMMENTED', user: { login: 'b' } },
      { state: 'PENDING', user: { login: 'c' } },
    ]);
    expect(states.get('a')?.state).toBe('APPROVED');
    // A trailing COMMENTED does not demote a standing verdict.
    expect(states.get('b')?.state).toBe('COMMENTED');
    expect(states.has('c')).toBe(false);
  });

  test('a dismissal clears the verdict back to COMMENTED', () => {
    const states = foldReviewStates([
      { state: 'APPROVED', user: { login: 'a' } },
      { state: 'DISMISSED', user: { login: 'a' } },
    ]);
    expect(states.get('a')?.state).toBe('COMMENTED');
  });
});

describe('pull details pagination and degradation', () => {
  test('folds reviewer verdicts across every chronological page', async () => {
    const fetcher: PlainFetch = (input) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const page = new URL(url).searchParams.get('page');
      return Promise.resolve(
        Response.json(
          page === '1'
            ? Array.from({ length: 100 }, () => ({
                state: 'COMMENTED',
                user: { login: 'reviewer' },
              }))
            : [{ state: 'APPROVED', user: { login: 'reviewer' } }]
        )
      );
    };
    const states = await fetchPullReviewStates(
      { owner: 'octo', repo: 'demo' },
      '1',
      undefined,
      fetcher
    );
    expect(states.get('reviewer')?.state).toBe('APPROVED');
  });

  test('keeps legacy statuses when check runs are unavailable', async () => {
    const fetcher: PlainFetch = (input) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.includes('/check-runs')) {
        return Promise.resolve(new Response('forbidden', { status: 403 }));
      }
      return Promise.resolve(
        Response.json({
          statuses: url.includes('page=1')
            ? [{ context: 'legacy', state: 'success' }]
            : [],
        })
      );
    };
    const checks = await fetchPullChecks(
      { owner: 'octo', repo: 'demo' },
      'abcdef0',
      undefined,
      fetcher
    );
    expect(checks).toEqual([{ name: 'legacy', state: 'success' }]);
  });
});

describe('merge capabilities', () => {
  test('uses viewer permissions and repository-enabled methods', () => {
    expect(
      parsePullMergeCapabilities({
        allow_merge_commit: false,
        allow_rebase_merge: true,
        allow_squash_merge: true,
        permissions: { push: true },
      })
    ).toEqual({ canMerge: true, methods: ['squash', 'rebase'] });
    expect(parsePullMergeCapabilities(null)).toEqual({
      canMerge: false,
      methods: [],
    });
  });
});

describe('mergePullReviewers', () => {
  test('overlays submitted verdicts without losing pending requests', () => {
    expect(
      mergePullReviewers(
        [
          { avatarUrl: 'requested.png', login: 'a', state: 'PENDING' },
          { login: 'b', state: 'PENDING' },
        ],
        [
          { avatarUrl: 'submitted.png', login: 'a', state: 'APPROVED' },
          { login: 'c', state: 'COMMENTED' },
        ]
      )
    ).toEqual([
      { avatarUrl: 'requested.png', login: 'a', state: 'APPROVED' },
      { login: 'b', state: 'PENDING' },
      { login: 'c', state: 'COMMENTED' },
    ]);
  });
});

describe('check normalization', () => {
  test('check runs map status/conclusion onto the four UI states', () => {
    expect(
      normalizeCheckRun({
        conclusion: null,
        html_url: 'https://ci/1',
        name: 'build',
        status: 'in_progress',
      })
    ).toEqual({ detailsUrl: 'https://ci/1', name: 'build', state: 'pending' });
    expect(
      normalizeCheckRun({
        conclusion: 'success',
        name: 'build',
        status: 'completed',
      })?.state
    ).toBe('success');
    expect(
      normalizeCheckRun({
        conclusion: 'timed_out',
        name: 'build',
        status: 'completed',
      })?.state
    ).toBe('failure');
    expect(
      normalizeCheckRun({
        conclusion: 'skipped',
        name: 'build',
        status: 'completed',
      })?.state
    ).toBe('neutral');
    expect(normalizeCheckRun({ status: 'completed' })).toBeNull();
  });

  test('legacy commit statuses map onto the same states', () => {
    expect(
      normalizeCommitStatus({
        context: 'ci/legacy',
        state: 'error',
        target_url: 'https://ci/2',
      })
    ).toEqual({
      detailsUrl: 'https://ci/2',
      name: 'ci/legacy',
      state: 'failure',
    });
    expect(
      normalizeCommitStatus({ context: 'ci/legacy', state: 'pending' })?.state
    ).toBe('pending');
    expect(normalizeCommitStatus({ state: 'success' })).toBeNull();
  });
});
