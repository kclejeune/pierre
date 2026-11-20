import { describe, expect, test } from 'bun:test';

import {
  fetchPullChecks,
  fetchPullReviewStates,
  foldReviewStates,
  normalizeCheckRun,
  normalizeCommitStatus,
  parsePullDetails,
  parsePullMergeCapabilities,
  parsePullMergeQueueStatus,
  parsePullViewerPermissions,
  parseReviewerCandidates,
  readPullEditRequest,
  readPullLabelChange,
  readPullReviewerChange,
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
      { login: 'core-team', state: 'PENDING', team: true },
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
        repository: {
          viewerPermission: 'WRITE',
          mergeCommitAllowed: false,
          rebaseMergeAllowed: true,
          squashMergeAllowed: true,
        },
      })
    ).toEqual({ canMerge: true, methods: ['squash', 'rebase'] });
    expect(
      parsePullMergeCapabilities({
        repository: { viewerPermission: 'READ', squashMergeAllowed: true },
      })
    ).toEqual({ canMerge: false, methods: ['squash'] });
    expect(parsePullMergeCapabilities(null)).toEqual({
      canMerge: false,
      methods: [],
    });
  });

  // GitHub's "Bypass requirements": offered to viewers who may merge as
  // admin, only while the pull isn't already mergeable.
  test('offers a bypass only to admins of a blocked pull', () => {
    const capabilities = (
      viewerCanMergeAsAdmin: boolean,
      mergeStateStatus: string
    ) =>
      parsePullMergeCapabilities({
        repository: {
          viewerPermission: 'ADMIN',
          squashMergeAllowed: true,
          pullRequest: { mergeStateStatus, viewerCanMergeAsAdmin },
        },
      }).canBypass;
    expect(capabilities(true, 'BLOCKED')).toBe(true);
    expect(capabilities(true, 'BEHIND')).toBe(true);
    expect(capabilities(true, 'CLEAN')).toBeUndefined();
    expect(capabilities(true, 'UNKNOWN')).toBeUndefined();
    expect(capabilities(false, 'BLOCKED')).toBeUndefined();
  });

  test('reads where the pull stands in a merge queue', () => {
    expect(
      parsePullMergeQueueStatus({
        isMergeQueueEnabled: true,
        mergeQueueEntry: { position: 2, state: 'AWAITING_CHECKS' },
        autoMergeRequest: { enabledAt: '2026-11-17T20:00:00Z' },
      })
    ).toEqual({
      entry: { position: 2, state: 'AWAITING_CHECKS' },
      pendingAutoMerge: false,
    });
    // Auto-merge on but not queued yet: waiting on required checks.
    expect(
      parsePullMergeQueueStatus({
        isMergeQueueEnabled: true,
        mergeQueueEntry: null,
        autoMergeRequest: { enabledAt: '2026-11-17T20:00:00Z' },
      })
    ).toEqual({ entry: null, pendingAutoMerge: true });
    expect(
      parsePullMergeQueueStatus({
        isMergeQueueEnabled: false,
        autoMergeRequest: {},
      })
    ).toBeNull();
  });
});

describe('parsePullViewerPermissions', () => {
  test('reads viewerCanUpdate and label rights from viewerPermission', () => {
    expect(
      parsePullViewerPermissions({
        repository: {
          pullRequest: { viewerCanUpdate: true },
          viewerPermission: 'TRIAGE',
        },
      })
    ).toEqual({ canLabel: true, canRequestReviews: true, canUpdate: true });
    expect(
      parsePullViewerPermissions({
        repository: {
          pullRequest: { viewerCanUpdate: false },
          viewerPermission: 'READ',
        },
      })
    ).toEqual({ canLabel: false, canRequestReviews: false, canUpdate: false });
    expect(parsePullViewerPermissions(null)).toEqual({
      canLabel: false,
      canRequestReviews: false,
      canUpdate: false,
    });
  });
});

describe('readPullReviewerChange', () => {
  const pull = { owner: 'o', pull: '7', repo: 'r' };

  test('accepts add and remove with a valid login', () => {
    expect(
      readPullReviewerChange({ ...pull, action: 'add', login: 'octo-cat' })
    ).toEqual({ ...pull, action: 'add', login: 'octo-cat' });
    expect(
      readPullReviewerChange({ ...pull, action: 'remove', login: 'a1' })
    ).toEqual({ ...pull, action: 'remove', login: 'a1' });
    // GHE managed users carry underscores.
    expect(
      readPullReviewerChange({ ...pull, action: 'add', login: 'jane_acme' })
    ).toEqual({ ...pull, action: 'add', login: 'jane_acme' });
  });

  test('rejects bad actions, logins, and refs', () => {
    expect(
      readPullReviewerChange({ ...pull, action: 'toggle', login: 'a' })
    ).toBeNull();
    for (const login of [
      '',
      '-a',
      'a b',
      'app/bot',
      'org/team',
      'x'.repeat(40),
    ]) {
      expect(
        readPullReviewerChange({ ...pull, action: 'add', login })
      ).toBeNull();
    }
    expect(
      readPullReviewerChange({
        owner: 'o',
        repo: 'r',
        action: 'add',
        login: 'a',
      })
    ).toBeNull();
  });
});

describe('parseReviewerCandidates', () => {
  test('reads logins, names, and avatars, skipping nameless nodes', () => {
    expect(
      parseReviewerCandidates({
        repository: {
          assignableUsers: {
            nodes: [
              {
                login: 'octocat',
                name: 'The Octocat',
                avatarUrl: 'https://a/1',
              },
              { login: 'hubot', name: '', avatarUrl: null },
              { name: 'no login' },
              null,
            ],
          },
        },
      })
    ).toEqual([
      { avatarUrl: 'https://a/1', login: 'octocat', name: 'The Octocat' },
      { login: 'hubot' },
    ]);
    expect(parseReviewerCandidates(null)).toEqual([]);
  });
});

describe('readPullEditRequest', () => {
  const pull = { owner: 'o', pull: '7', repo: 'r' };

  test('keeps only the provided fields, trimming the title', () => {
    expect(readPullEditRequest({ ...pull, title: '  New title ' })).toEqual({
      ...pull,
      title: 'New title',
    });
    expect(readPullEditRequest({ ...pull, body: '' })).toEqual({
      ...pull,
      body: '',
    });
  });

  test('accepts state changes and draft toggles', () => {
    expect(readPullEditRequest({ ...pull, state: 'closed' })).toEqual({
      ...pull,
      state: 'closed',
    });
    expect(readPullEditRequest({ ...pull, draft: false })).toEqual({
      ...pull,
      draft: false,
    });
  });

  test('rejects blank titles, unknown states, and empty edits', () => {
    expect(readPullEditRequest({ ...pull, title: '   ' })).toBeNull();
    expect(readPullEditRequest({ ...pull, state: 'merged' })).toBeNull();
    expect(readPullEditRequest({ ...pull, draft: 'yes' })).toBeNull();
    expect(readPullEditRequest(pull)).toBeNull();
    expect(readPullEditRequest({ ...pull, pull: 'x', title: 't' })).toBeNull();
  });
});

describe('readPullLabelChange', () => {
  test('accepts one label add or removal', () => {
    expect(
      readPullLabelChange({
        action: 'remove',
        label: 'bug',
        owner: 'o',
        pull: '7',
        repo: 'r',
      })
    ).toEqual({
      action: 'remove',
      label: 'bug',
      owner: 'o',
      pull: '7',
      repo: 'r',
    });
  });

  test('rejects unknown actions and empty labels', () => {
    const pull = { owner: 'o', pull: '7', repo: 'r' };
    expect(
      readPullLabelChange({ ...pull, action: 'set', label: 'bug' })
    ).toBeNull();
    expect(
      readPullLabelChange({ ...pull, action: 'add', label: '' })
    ).toBeNull();
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
