import { describe, expect, test } from 'bun:test';

import {
  detachString,
  releaseStringDetachBuffer,
} from '../src/utils/detachString';

describe('detachString', () => {
  test('returns equal strings for one-byte input', () => {
    const value = 'const answer = 42;'.repeat(200);
    expect(detachString(value)).toBe(value);
  });

  test('grows past the one-byte estimate for multi-byte input', () => {
    releaseStringDetachBuffer();
    // Mostly ASCII so the optimistic buffer runs out part-way through, then
    // two- and three-byte sequences that force the growth path.
    const value = `${'x'.repeat(900)}${'ü'.repeat(400)}${'日本語'.repeat(100)}`;
    expect(detachString(value)).toBe(value);
    // A second call reuses the grown buffer without re-growing.
    expect(detachString(value)).toBe(value);
  });

  test('preserves surrogate pairs and lone surrogates', () => {
    const emoji = 'done 😀 \u{1F680} end';
    expect(detachString(emoji)).toBe(emoji);
    const lone = 'broken \uD800 text';
    expect(detachString(lone)).toBe(lone);
  });

  test('keeps surrogate pairs intact across the growth boundary', () => {
    releaseStringDetachBuffer();
    // Enough 4-byte emoji that the optimistic buffer runs out mid-run; the
    // second encode pass must start on a code point boundary.
    const value = `${'x'.repeat(1000)}${'😀'.repeat(300)}`;
    expect(detachString(value)).toBe(value);
  });

  test('returns the empty string unchanged', () => {
    expect(detachString('')).toBe('');
  });
});
