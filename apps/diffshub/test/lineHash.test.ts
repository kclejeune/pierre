import { describe, expect, test } from 'bun:test';

import {
  formatDiffsHubItemHash,
  formatDiffsHubLineHash,
  parseDiffsHubLineHash,
} from '@/lib/lineHash';

describe('parseDiffsHubLineHash', () => {
  test('parses a ranged target', () => {
    expect(parseDiffsHubLineHash('#target=src/app.ts&start=A4&end=D9')).toEqual(
      {
        itemId: 'src/app.ts',
        range: { start: 4, side: 'additions', end: 9, endSide: 'deletions' },
      }
    );
  });

  test('parses a single-point target without an end', () => {
    expect(parseDiffsHubLineHash('#target=src/app.ts&start=A4')).toEqual({
      itemId: 'src/app.ts',
      range: { start: 4, side: 'additions', end: 4 },
    });
  });

  test('parses a file-only target with a null range', () => {
    expect(parseDiffsHubLineHash('#target=docs/readme.md')).toEqual({
      itemId: 'docs/readme.md',
      range: null,
    });
  });

  test('rejects a malformed start point', () => {
    expect(parseDiffsHubLineHash('#target=src/app.ts&start=X4')).toBeNull();
  });

  test('rejects an empty hash', () => {
    expect(parseDiffsHubLineHash('#')).toBeNull();
  });
});

describe('format round-trips', () => {
  test('formatDiffsHubItemHash round-trips through parse', () => {
    const hash = formatDiffsHubItemHash('docs/read me?.md');
    expect(hash).not.toBeNull();
    expect(parseDiffsHubLineHash(hash ?? '')).toEqual({
      itemId: 'docs/read me?.md',
      range: null,
    });
  });

  test('formatDiffsHubLineHash round-trips through parse', () => {
    const hash = formatDiffsHubLineHash({
      id: 'src/app.ts',
      range: { start: 4, side: 'additions', end: 9, endSide: 'deletions' },
    });
    expect(hash).not.toBeNull();
    expect(parseDiffsHubLineHash(hash ?? '')).toEqual({
      itemId: 'src/app.ts',
      range: { start: 4, side: 'additions', end: 9, endSide: 'deletions' },
    });
  });
});
