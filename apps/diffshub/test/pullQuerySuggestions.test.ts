import { describe, expect, test } from 'bun:test';

import {
  applyQuerySuggestion,
  getQuerySuggestions,
} from '@/lib/pullQuerySuggestions';

const now = new Date('2026-11-18T12:00:00Z');

function labelsAt(text: string, caret = text.length, labels?: string[]) {
  return (
    getQuerySuggestions(text, caret, { labels, now })?.items.map(
      (item) => item.text
    ) ?? null
  );
}

describe('getQuerySuggestions', () => {
  test('completes qualifier keys, prefix matches first', () => {
    expect(labelsAt('is:open aut')).toEqual(['author:']);
    const reviews = labelsAt('review');
    expect(reviews?.slice(0, 3)).toEqual([
      'review:',
      'review-requested:',
      'reviewed-by:',
    ]);
    // Contains-matches follow: "requested" appears mid-key.
    expect(labelsAt('requested')).toEqual([
      'review-requested:',
      'team-review-requested:',
      'user-review-requested:',
    ]);
  });

  test('completes values once the colon is typed', () => {
    expect(labelsAt('is:')).toContain('is:merged');
    expect(labelsAt('is:me')).toEqual(['is:merged', 'is:unmerged']);
    expect(labelsAt('author:')).toEqual(['author:@me']);
    expect(labelsAt('created:')?.[1]).toBe('created:>=2026-11-11');
  });

  test('keeps negation and range positions', () => {
    const result = getQuerySuggestions('is:open -lab', 12, { now });
    expect(result?.from).toBe(8);
    expect(result?.to).toBe(12);
    expect(result?.items[0].text).toBe('-label:');
  });

  test('offers repo labels, quoting names with spaces', () => {
    expect(labelsAt('label:', 6, ['bug', 'needs review'])).toEqual([
      'label:bug',
      'label:"needs review"',
    ]);
    expect(labelsAt('label:"nee', 10, ['bug', 'needs review'])).toEqual([
      'label:"needs review"',
    ]);
  });

  test('stays quiet with nothing to complete', () => {
    expect(labelsAt('')).toBeNull();
    expect(labelsAt('is:open ')).toBeNull();
    expect(labelsAt('is:open')).toBeNull();
    expect(labelsAt('zzz')).toBeNull();
    expect(labelsAt('bogus:')).toBeNull();
  });

  test('completes the word under a mid-text caret', () => {
    const text = 'is:op author:@me';
    const result = getQuerySuggestions(text, 5, { now });
    expect(result?.items.map((item) => item.text)).toEqual(['is:open']);
    expect(result?.to).toBe(5);
  });
});

describe('getQuerySuggestions edge cases', () => {
  test('a completed value closes the list instead of offering rivals', () => {
    expect(labelsAt('is:merged')).toBeNull();
    expect(labelsAt('is:locked')).toBeNull();
    expect(labelsAt('-is:merged')).toBeNull();
    // Still offered while the word is a strict prefix.
    expect(labelsAt('is:merge')).toEqual(['is:merged', 'is:unmerged']);
  });

  test('ignores keys that name Object.prototype members', () => {
    expect(labelsAt('constructor:')).toBeNull();
    expect(labelsAt('__proto__:')).toBeNull();
    expect(labelsAt('toString:x')).toBeNull();
  });

  test('omits labels a search value cannot express', () => {
    expect(labelsAt('label:', 6, ['a"b', 'bug'])).toEqual(['label:bug']);
  });
});

describe('applyQuerySuggestion', () => {
  test('a key stops at its colon', () => {
    const text = 'is:open aut';
    const result = getQuerySuggestions(text, text.length, { now });
    expect(result).not.toBeNull();
    expect(applyQuerySuggestion(text, result!, result!.items[0])).toEqual({
      caret: 15,
      text: 'is:open author:',
    });
  });

  test('a value gets one trailing space', () => {
    expect(
      applyQuerySuggestion('is:me', { from: 0, to: 5 }, { text: 'is:merged' })
    ).toEqual({ caret: 10, text: 'is:merged ' });
    expect(
      applyQuerySuggestion(
        'is:me author:@me',
        { from: 0, to: 5 },
        { text: 'is:merged' }
      )
    ).toEqual({ caret: 10, text: 'is:merged author:@me' });
  });
});
