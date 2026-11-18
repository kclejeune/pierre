import { describe, expect, test } from 'bun:test';

import {
  addMutedAuthors,
  authorSearchName,
  isValidMutedAuthor,
  MAX_MUTED_AUTHORS,
  mutedAuthorLabel,
  parseMutedAuthors,
  removeMutedAuthor,
} from '@/lib/mutedAuthors';

describe('muted authors', () => {
  test('bots search as app/<login>, people by login', () => {
    expect(
      authorSearchName({ authorIsBot: true, authorLogin: 'renovate' })
    ).toBe('app/renovate');
    // REST-style app logins carry a [bot] suffix the app/ form drops.
    expect(
      authorSearchName({ authorIsBot: true, authorLogin: 'dependabot[bot]' })
    ).toBe('app/dependabot');
    expect(authorSearchName({ authorLogin: 'octocat' })).toBe('octocat');
    expect(authorSearchName({})).toBeUndefined();
    expect(mutedAuthorLabel('app/renovate')).toBe('renovate');
    expect(mutedAuthorLabel('octocat')).toBe('octocat');
  });

  // Names go straight into search qualifiers, so anything that could add a
  // term or operator is rejected.
  test('accepts only login-shaped names', () => {
    expect(isValidMutedAuthor('app/renovate')).toBe(true);
    expect(isValidMutedAuthor('svc-bump_ci')).toBe(true);
    expect(isValidMutedAuthor('app/')).toBe(false);
    expect(isValidMutedAuthor('a b')).toBe(false);
    expect(isValidMutedAuthor('x:y')).toBe(false);
    expect(isValidMutedAuthor('-x')).toBe(false);
    expect(isValidMutedAuthor('a'.repeat(40))).toBe(false);
  });

  test('parses, de-duplicates, and caps stored lists', () => {
    expect(parseMutedAuthors('nope')).toEqual([]);
    expect(parseMutedAuthors(['Octocat', 'octocat', 7, 'bad name'])).toEqual([
      'Octocat',
    ]);
    const many = Array.from({ length: 30 }, (_, index) => `u${index}`);
    expect(parseMutedAuthors(many)).toHaveLength(MAX_MUTED_AUTHORS);
  });

  test('adds and removes case-insensitively', () => {
    expect(addMutedAuthors(['octocat'], ['OctoCat', 'app/renovate'])).toEqual([
      'octocat',
      'app/renovate',
    ]);
    expect(removeMutedAuthor(['octocat', 'app/renovate'], 'OCTOCAT')).toEqual([
      'app/renovate',
    ]);
  });
});
