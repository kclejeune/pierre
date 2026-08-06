import { describe, expect, test } from 'bun:test';

import {
  compileCollapsePatterns,
  matchesCollapsePattern,
  parseCollapsePatterns,
} from '@/lib/collapsePatterns';

function matches(pattern: string, path: string): boolean {
  return matchesCollapsePattern(
    path,
    compileCollapsePatterns(parseCollapsePatterns(pattern))
  );
}

describe('parseCollapsePatterns', () => {
  test('splits on newlines and commas, drops blanks and comments', () => {
    expect(
      parseCollapsePatterns('vendor/**\n\n# generated\n*.pb.go, dist')
    ).toEqual(['vendor/**', '*.pb.go', 'dist']);
  });
});

describe('matchesCollapsePattern', () => {
  test('** crosses directory separators', () => {
    expect(matches('vendor/**', 'vendor/golang.org/x/net/http2.go')).toBe(true);
    expect(matches('vendor/**', 'cmd/vendor.go')).toBe(false);
  });

  test('* stays within one path segment', () => {
    expect(matches('*.pb.go', 'api.pb.go')).toBe(true);
    expect(matches('*.pb.go', 'proto/api.pb.go')).toBe(false);
    expect(matches('**/*.pb.go', 'proto/api.pb.go')).toBe(true);
  });

  test('literal patterns match as directory prefixes', () => {
    expect(matches('vendor', 'vendor/modules.txt')).toBe(true);
    expect(matches('vendor', 'vendor')).toBe(true);
    expect(matches('vendor', 'vendored/file.go')).toBe(false);
  });

  test('glob patterns anchor to the full path', () => {
    expect(matches('dist/*', 'dist/main.js')).toBe(true);
    expect(matches('dist/*', 'dist/assets/main.js')).toBe(false);
  });

  test('regex metacharacters in patterns are literal', () => {
    expect(matches('a+b/c.txt', 'a+b/c.txt')).toBe(true);
    expect(matches('a+b/c.txt', 'aab/cxtxt')).toBe(false);
  });

  test('empty input matches nothing', () => {
    expect(matches('', 'anything')).toBe(false);
  });
});
