import { describe, expect, test } from 'bun:test';

import {
  type CompareFile,
  countRemainingConflicts,
  isBinaryContent,
  planMerge,
  renderConflictMarkers,
} from '@/lib/pullMerge';

const LABELS = { base: 'merge-base', ours: 'feature', theirs: 'main' };

function file(
  filename: string,
  status: CompareFile['status'],
  previousFilename?: string
): CompareFile {
  return previousFilename == null
    ? { filename, status }
    : { filename, previousFilename, status };
}

describe('planMerge', () => {
  test('head-only changes need no entries at all', () => {
    expect(
      planMerge({
        baseChanges: [],
        headChanges: [file('src/app.ts', 'modified')],
      })
    ).toEqual([]);
  });

  test('base-only add/modify takes base, base-only removal deletes', () => {
    const plans = planMerge({
      baseChanges: [
        file('docs/new.md', 'added'),
        file('src/lib.ts', 'modified'),
        file('src/old.ts', 'removed'),
      ],
      headChanges: [file('src/app.ts', 'modified')],
    });
    expect(plans).toEqual([
      { kind: 'take-base', path: 'docs/new.md' },
      { kind: 'take-base', path: 'src/lib.ts' },
      { kind: 'delete', path: 'src/old.ts' },
    ]);
  });

  test('both-modified merges; add/add merges against an empty base', () => {
    const plans = planMerge({
      baseChanges: [
        file('src/shared.ts', 'modified'),
        file('src/brand-new.ts', 'added'),
      ],
      headChanges: [
        file('src/shared.ts', 'modified'),
        file('src/brand-new.ts', 'added'),
      ],
    });
    expect(plans).toEqual([
      { kind: 'merge', path: 'src/shared.ts', addAdd: false },
      { kind: 'merge', path: 'src/brand-new.ts', addAdd: true },
    ]);
  });

  test('both-removed needs nothing', () => {
    expect(
      planMerge({
        baseChanges: [file('gone.ts', 'removed')],
        headChanges: [file('gone.ts', 'removed')],
      })
    ).toEqual([]);
  });

  test('delete/modify in either direction is unsupported', () => {
    const baseDeleted = planMerge({
      baseChanges: [file('a.ts', 'removed')],
      headChanges: [file('a.ts', 'modified')],
    });
    expect(baseDeleted[0]?.kind).toBe('unsupported');
    const headDeleted = planMerge({
      baseChanges: [file('a.ts', 'modified')],
      headChanges: [file('a.ts', 'removed')],
    });
    expect(headDeleted[0]?.kind).toBe('unsupported');
  });

  test('an uncontested base rename becomes take-base plus delete', () => {
    expect(
      planMerge({
        baseChanges: [file('src/new-name.ts', 'renamed', 'src/old-name.ts')],
        headChanges: [file('unrelated.ts', 'modified')],
      })
    ).toEqual([
      { kind: 'take-base', path: 'src/new-name.ts' },
      { kind: 'delete', path: 'src/old-name.ts' },
    ]);
  });

  test('renames touching contested paths are unsupported', () => {
    const contestedTarget = planMerge({
      baseChanges: [file('src/new.ts', 'renamed', 'src/old.ts')],
      headChanges: [file('src/new.ts', 'added')],
    });
    expect(contestedTarget[0]?.kind).toBe('unsupported');
    const contestedSource = planMerge({
      baseChanges: [file('src/new.ts', 'renamed', 'src/old.ts')],
      headChanges: [file('src/old.ts', 'modified')],
    });
    expect(contestedSource[0]?.kind).toBe('unsupported');
    const headRenamed = planMerge({
      baseChanges: [file('src/shared.ts', 'modified')],
      headChanges: [file('src/moved.ts', 'renamed', 'src/shared.ts')],
    });
    expect(headRenamed[0]?.kind).toBe('unsupported');
  });

  test('type changes merge only when uncontested', () => {
    expect(
      planMerge({
        baseChanges: [file('link', 'changed')],
        headChanges: [],
      })
    ).toEqual([{ kind: 'take-base', path: 'link' }]);
    expect(
      planMerge({
        baseChanges: [file('link', 'changed')],
        headChanges: [file('link', 'modified')],
      })[0]?.kind
    ).toBe('unsupported');
  });
});

describe('renderConflictMarkers', () => {
  const base = 'a\nshared\nz\n';

  test('non-overlapping edits merge cleanly with no markers', () => {
    const result = renderConflictMarkers(
      base,
      'a-ours\nshared\nz\n',
      'a\nshared\nz-theirs\n',
      LABELS
    );
    expect(result.conflictCount).toBe(0);
    expect(result.text).toBe('a-ours\nshared\nz-theirs\n');
  });

  test('overlapping edits emit git-style markers with a base section', () => {
    const result = renderConflictMarkers(
      base,
      'a\nours\nz\n',
      'a\ntheirs\nz\n',
      LABELS
    );
    expect(result.conflictCount).toBe(1);
    expect(result.text).toBe(
      [
        'a',
        '<<<<<<< feature',
        'ours',
        '||||||| merge-base',
        'shared',
        '=======',
        'theirs',
        '>>>>>>> main',
        'z',
        '',
      ].join('\n')
    );
    expect(countRemainingConflicts(result.text)).toBe(1);
  });

  test('preserves trailing-newline absence and CRLF content', () => {
    const noTrailing = renderConflictMarkers('x', 'x', 'x', LABELS);
    expect(noTrailing.text).toBe('x');
    const crlf = renderConflictMarkers(
      'a\r\nb\r\n',
      'a\r\nb\r\n',
      'a\r\nb\r\n',
      LABELS
    );
    expect(crlf.text).toBe('a\r\nb\r\n');
  });

  test('add/add with an empty base yields one conflict', () => {
    const result = renderConflictMarkers('', 'ours\n', 'theirs\n', LABELS);
    expect(result.conflictCount).toBe(1);
  });
});

describe('countRemainingConflicts', () => {
  test('counts only conflict-start markers at line starts', () => {
    const text = [
      '<<<<<<< feature',
      'x',
      '=======',
      'y',
      '>>>>>>> main',
      'prose about <<<<<<< arrows',
      '<<<<<<<',
    ].join('\n');
    expect(countRemainingConflicts(text)).toBe(2);
  });
});

describe('isBinaryContent', () => {
  test('detects NUL bytes', () => {
    expect(isBinaryContent('plain text')).toBe(false);
    expect(isBinaryContent('bin\0ary')).toBe(true);
  });
});
