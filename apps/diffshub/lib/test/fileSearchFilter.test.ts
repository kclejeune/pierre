import { describe, expect, test } from 'bun:test';

import { filterFilePathsForSearch } from '../fileSearchFilter';

const PATHS = [
  'README.md',
  'apps/web/package.json',
  'packages/trees/src/FileTreeController.ts',
  'packages/trees/src/react/useFileTreeSearch.ts',
  'src/components/Button.tsx',
  'src/components/useRepoRefs.ts',
  'src/lib/repoBrowser.ts',
];

describe('filterFilePathsForSearch', () => {
  test('an empty query returns the listing order, capped to the limit', () => {
    expect(filterFilePathsForSearch(PATHS, '')).toEqual(PATHS);
    expect(filterFilePathsForSearch(PATHS, '   ', 2)).toEqual(
      PATHS.slice(0, 2)
    );
  });

  test('matching is case-insensitive', () => {
    expect(filterFilePathsForSearch(PATHS, 'readme')).toEqual(['README.md']);
  });

  test('basename matches rank above directory-only matches', () => {
    // "tree" appears only in the directory of packages/trees/src/index.ts but
    // in the basename of the other two; the basename hits must lead.
    const results = filterFilePathsForSearch(
      [...PATHS, 'packages/trees/src/index.ts'],
      'tree'
    );
    expect(results.slice(0, 2).sort()).toEqual([
      'packages/trees/src/FileTreeController.ts',
      'packages/trees/src/react/useFileTreeSearch.ts',
    ]);
    expect(results[2]).toBe('packages/trees/src/index.ts');
  });

  test('subsequence matches surface files without a contiguous hit', () => {
    expect(filterFilePathsForSearch(PATHS, 'usrref')).toEqual([
      'src/components/useRepoRefs.ts',
    ]);
  });

  test('non-matching queries return nothing', () => {
    expect(filterFilePathsForSearch(PATHS, 'zzzz')).toEqual([]);
  });

  test('earlier basename matches beat later ones', () => {
    const results = filterFilePathsForSearch(
      ['src/theButton.tsx', 'src/Button.tsx'],
      'button'
    );
    expect(results).toEqual(['src/Button.tsx', 'src/theButton.tsx']);
  });

  test('results are capped to the limit', () => {
    const many = Array.from({ length: 80 }, (_, i) => `dir/file${i}.ts`);
    expect(filterFilePathsForSearch(many, 'file')).toHaveLength(50);
  });
});
