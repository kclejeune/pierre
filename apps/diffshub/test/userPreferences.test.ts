import { describe, expect, test } from 'bun:test';

import {
  describeInvalidPreferenceKey,
  looksLikeCredential,
  MAX_PREFERENCE_KEYS,
  mergePreferenceChanges,
  parseStoredPreferences,
} from '../lib/userPreferences';

describe('user preference validation', () => {
  test('accepts ordinary keys, including credential-sounding names', () => {
    for (const key of [
      'display.diffStyle',
      'pinned-repos',
      'authorFilter',
      'oauthHint',
      'sessionLayout',
      'tokenizerTheme',
    ]) {
      expect(describeInvalidPreferenceKey(key)).toBeNull();
    }
    expect(describeInvalidPreferenceKey('')).not.toBeNull();
    expect(describeInvalidPreferenceKey('a/b')).not.toBeNull();
    expect(describeInvalidPreferenceKey('x'.repeat(65))).not.toBeNull();
  });

  test('refuses keys that are themselves credentials', () => {
    expect(describeInvalidPreferenceKey(`ghp_${'a'.repeat(36)}`)).toContain(
      'credential'
    );
    expect(describeInvalidPreferenceKey('my-key-42', ['my-key-42'])).toContain(
      'credential'
    );
  });

  test('recognizes credential-shaped strings', () => {
    expect(looksLikeCredential(`ghp_${'a'.repeat(36)}`)).toBe(true);
    expect(looksLikeCredential(`prefix ghu_${'B'.repeat(36)}`)).toBe(true);
    expect(looksLikeCredential(`github_pat_${'c'.repeat(40)}`)).toBe(true);
    expect(looksLikeCredential('dhe1.access.bm9uY2U.Y2lwaGVy')).toBe(true);
    expect(looksLikeCredential('dhe1.refresh.bm9uY2U.Y2lwaGVy')).toBe(true);
    expect(looksLikeCredential('dhr1.cGF5bG9hZA.bWFj')).toBe(true);
    expect(looksLikeCredential('eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.sig')).toBe(
      true
    );
    expect(looksLikeCredential(`Bearer ${'z'.repeat(20)}`)).toBe(true);
    expect(looksLikeCredential('one-dark-pro')).toBe(false);
    expect(looksLikeCredential('acme/widgets')).toBe(false);
    expect(looksLikeCredential('dhe1.notes')).toBe(false);
    // No word boundary is required before a prefix.
    expect(looksLikeCredential(`backup_ghp_${'a'.repeat(36)}`)).toBe(true);
    expect(looksLikeCredential(`xgithub_pat_${'c'.repeat(40)}`)).toBe(true);
    expect(looksLikeCredential('mydhe1.access.bm9uY2U.Y2lwaGVy')).toBe(true);
    expect(looksLikeCredential('xdhr1.cGF5bG9hZA.bWFj')).toBe(true);
    expect(looksLikeCredential('the bearer of news')).toBe(false);
  });

  test('merges changes, deleting keys set to null', () => {
    const result = mergePreferenceChanges(
      { diffStyle: 'split', theme: 'one-dark-pro' },
      { diffStyle: null, pinnedRepos: ['acme/widgets'] }
    );
    const expected = { pinnedRepos: ['acme/widgets'], theme: 'one-dark-pro' };
    expect(result.preferences).toEqual(expected);
    expect(JSON.parse(result.serialized ?? '')).toEqual(expected);
  });

  test('refuses forbidden substrings anywhere in a value', () => {
    expect(
      mergePreferenceChanges({}, { note: { list: ['x-secret-x'] } }, ['secret'])
        .error
    ).toContain('credential');
  });

  test('refuses credentials nested anywhere in a value', () => {
    const token = `gho_${'q'.repeat(36)}`;
    expect(
      mergePreferenceChanges({}, { layout: { panes: [{ note: token }] } }).error
    ).toContain('credential');
    expect(
      mergePreferenceChanges({}, { layout: { [token]: true } }).error
    ).toContain('credential');
  });

  test('refuses non-JSON values and oversized maps', () => {
    expect(mergePreferenceChanges({}, { n: Number.NaN }).error).toBeDefined();
    expect(mergePreferenceChanges({}, { f: () => 1 }).error).toBeDefined();
    // Per-value cap is 32 KiB.
    expect(
      mergePreferenceChanges({}, { fits: 'x'.repeat(30_000) }).error
    ).toBeUndefined();
    expect(
      mergePreferenceChanges({}, { big: 'x'.repeat(33_000) }).error
    ).toBeDefined();
    // Total cap is 256 KiB, across values each under the per-value cap.
    const wide = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`v${i}`, 'x'.repeat(30_000)])
    );
    expect(mergePreferenceChanges({}, wide).error).toContain('in total');
    const many = Object.fromEntries(
      Array.from({ length: MAX_PREFERENCE_KEYS + 1 }, (_, i) => [`k${i}`, i])
    );
    expect(mergePreferenceChanges({}, many).error).toBeDefined();
  });

  test('drops invalid entries from stored blobs instead of failing', () => {
    expect(parseStoredPreferences(null)).toEqual({});
    expect(parseStoredPreferences('not json')).toEqual({});
    expect(parseStoredPreferences('[1,2]')).toEqual({});
    expect(
      parseStoredPreferences(
        JSON.stringify({
          note: `ghp_${'a'.repeat(36)}`,
          theme: 'one-dark-pro',
        })
      )
    ).toEqual({ theme: 'one-dark-pro' });
  });
});
