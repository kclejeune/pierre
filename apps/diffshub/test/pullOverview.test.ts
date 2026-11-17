import { describe, expect, test } from 'bun:test';

import type { PullDetails } from '../lib/pullInfoClient';
import {
  describeMergeHeadline,
  diffstatBlocks,
  summarizeApprovals,
  summarizeChecks,
  summarizeConversations,
} from '../lib/pullOverview';

const OPEN_PULL: PullDetails = {
  body: '',
  draft: false,
  labels: [],
  mergeable: true,
  mergeableState: 'clean',
  reviewers: [],
  state: 'open',
  title: 'Add overview',
};

describe('summarizeChecks', () => {
  test('failing beats pending and counts each state', () => {
    const metric = summarizeChecks([
      { name: 'a', state: 'success' },
      { name: 'b', state: 'failure' },
      { name: 'c', state: 'pending' },
    ]);
    expect(metric.summary).toBe('1 failing');
    expect(metric.tone).toBe('failure');
    expect(metric.segments).toEqual([
      { count: 1, tone: 'success' },
      { count: 1, tone: 'failure' },
      { count: 1, tone: 'pending' },
    ]);
  });

  test('no checks has no tone and an empty bar', () => {
    expect(summarizeChecks([])).toEqual({
      segments: [],
      summary: 'None reported',
      tone: null,
      toneCount: 0,
    });
  });
});

describe('summarizeConversations', () => {
  test('reports open conversations', () => {
    expect(
      summarizeConversations({ kind: 'counted', resolved: 1, total: 3 })
    ).toMatchObject({ summary: '2 unresolved', tone: 'pending' });
  });

  test('all resolved is a success', () => {
    expect(
      summarizeConversations({ kind: 'counted', resolved: 2, total: 2 })
    ).toMatchObject({ tone: 'success' });
  });

  test('unknown resolution reports the total, not unresolved', () => {
    expect(
      summarizeConversations({ kind: 'totalOnly', total: 5 })
    ).toMatchObject({ summary: '5 conversations', tone: 'neutral' });
  });

  test('a failed comment fetch is unavailable, not empty', () => {
    expect(summarizeConversations({ kind: 'unavailable' })).toMatchObject({
      kind: 'unavailable',
    });
  });
});

describe('summarizeApprovals', () => {
  test('a requested change wins over approvals', () => {
    const metric = summarizeApprovals([
      { login: 'a', state: 'APPROVED' },
      { login: 'b', state: 'CHANGES_REQUESTED' },
    ]);
    expect(metric.summary).toBe('Changes requested');
  });

  test('counts approvals out of all reviewers', () => {
    const metric = summarizeApprovals([
      { login: 'a', state: 'APPROVED' },
      { login: 'b', state: 'PENDING' },
    ]);
    expect(metric.summary).toBe('1 of 2 approved');
    expect(metric.segments).toEqual([
      { count: 1, tone: 'success' },
      { count: 1, tone: 'neutral' },
    ]);
  });
});

describe('describeMergeHeadline', () => {
  const passing = summarizeChecks([{ name: 'a', state: 'success' }]);
  const noReviewers = summarizeApprovals([]);

  test('ready when clean, passing, and nothing blocks', () => {
    expect(
      describeMergeHeadline({
        checks: passing,
        details: OPEN_PULL,
        reviewers: noReviewers,
      }).title
    ).toBe('Ready to merge');
  });

  test('never ready while checks are still loading', () => {
    expect(
      describeMergeHeadline({
        checks: { kind: 'loading' },
        details: OPEN_PULL,
        reviewers: noReviewers,
      }).tone
    ).toBe('pending');
  });

  test('an unavailable cell reports an incomplete status, not loading', () => {
    expect(
      describeMergeHeadline({
        checks: {
          kind: 'unavailable',
          reason: 'CI status could not be loaded.',
        },
        details: OPEN_PULL,
        reviewers: noReviewers,
      }).title
    ).toBe('Merge status incomplete');
  });

  test('conflicts outrank failing checks', () => {
    expect(
      describeMergeHeadline({
        checks: summarizeChecks([{ name: 'a', state: 'failure' }]),
        details: { ...OPEN_PULL, mergeable: false, mergeableState: 'dirty' },
        reviewers: noReviewers,
      }).title
    ).toBe('This branch has conflicts');
  });

  test('failing checks say how many failed', () => {
    expect(
      describeMergeHeadline({
        checks: summarizeChecks([
          { name: 'a', state: 'failure' },
          { name: 'b', state: 'failure' },
        ]),
        details: OPEN_PULL,
        reviewers: noReviewers,
      }).detail
    ).toBe('2 checks failed.');
  });

  test('a branch behind its base must update', () => {
    expect(
      describeMergeHeadline({
        checks: passing,
        details: { ...OPEN_PULL, mergeableState: 'behind' },
        reviewers: noReviewers,
      }).title
    ).toBe('Required to update');
  });

  test('merged pulls say so regardless of checks', () => {
    expect(
      describeMergeHeadline({
        checks: { kind: 'loading' },
        details: { ...OPEN_PULL, state: 'merged' },
        reviewers: { kind: 'loading' },
      }).tone
    ).toBe('merged');
  });
});

describe('diffstatBlocks', () => {
  test('splits squares by proportion, at least one per non-zero side', () => {
    expect(diffstatBlocks(34, 14)).toEqual([
      'added',
      'added',
      'added',
      'added',
      'deleted',
    ]);
    expect(diffstatBlocks(1000, 1)).toEqual([
      'added',
      'added',
      'added',
      'added',
      'deleted',
    ]);
    expect(diffstatBlocks(0, 5)).toEqual(Array(5).fill('deleted'));
  });

  test('no changes is all neutral', () => {
    expect(diffstatBlocks(0, 0)).toEqual(Array(5).fill('neutral'));
  });
});
