import { describe, expect, test } from 'bun:test';

import { diff3Merge } from '@/lib/diff3';
import {
  type CompareFile,
  countRemainingConflicts,
  isBinaryContent,
  type MergeOnto,
  mergePaths,
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
  test('base-only changes need no entries at all', () => {
    expect(
      planMerge(
        {
          baseChanges: [file('src/lib.ts', 'modified')],
          headChanges: [],
        },
        'base'
      )
    ).toEqual([]);
  });

  test('pull-only add/modify takes head, pull-only removal deletes', () => {
    expect(
      planMerge(
        {
          baseChanges: [file('src/lib.ts', 'modified')],
          headChanges: [
            file('docs/new.md', 'added'),
            file('src/app.ts', 'modified'),
            file('src/old.ts', 'removed'),
          ],
        },
        'base'
      )
    ).toEqual([
      { kind: 'take-head', path: 'docs/new.md' },
      { kind: 'take-head', path: 'src/app.ts' },
      { kind: 'delete', path: 'src/old.ts' },
    ]);
  });

  test('both-modified merges; add/add merges against an empty base', () => {
    const plans = planMerge(
      {
        baseChanges: [
          file('src/shared.ts', 'modified'),
          file('src/brand-new.ts', 'added'),
        ],
        headChanges: [
          file('src/shared.ts', 'modified'),
          file('src/brand-new.ts', 'added'),
        ],
      },
      'base'
    );
    expect(plans).toEqual([
      { kind: 'merge', path: 'src/shared.ts', addAdd: false },
      { kind: 'merge', path: 'src/brand-new.ts', addAdd: true },
    ]);
  });

  test('both-removed needs nothing', () => {
    expect(
      planMerge(
        {
          baseChanges: [file('gone.ts', 'removed')],
          headChanges: [file('gone.ts', 'removed')],
        },
        'base'
      )
    ).toEqual([]);
  });

  const refusals: [string, CompareFile[], CompareFile[], string][] = [
    [
      'base deleted, pull modified',
      [file('a.ts', 'removed')],
      [file('a.ts', 'modified')],
      'The base branch deleted this file but the pull request modified it',
    ],
    [
      'pull deleted, base modified',
      [file('a.ts', 'modified')],
      [file('a.ts', 'removed')],
      'The pull request deleted this file but the base branch modified it',
    ],
    [
      'pull rename onto a path base added',
      [file('src/new.ts', 'added')],
      [file('src/new.ts', 'renamed', 'src/old.ts')],
      'The pull request renamed this file and the base branch also touches it',
    ],
    [
      'pull rename of a file base modified',
      [file('src/old.ts', 'modified')],
      [file('src/new.ts', 'renamed', 'src/old.ts')],
      'The pull request renamed this file and the base branch also touches it',
    ],
    [
      'base rename of a file the pull modified',
      [file('src/moved.ts', 'renamed', 'src/shared.ts')],
      [file('src/shared.ts', 'modified')],
      'The base branch renamed this file while the pull request changed it',
    ],
    [
      'base rename of a file the pull deleted',
      [file('src/moved.ts', 'renamed', 'src/shared.ts')],
      [file('src/shared.ts', 'removed')],
      'The base branch renamed this file but the pull request deleted it',
    ],
    [
      'pull rename of a file base deleted',
      [file('src/old.ts', 'removed')],
      [file('src/new.ts', 'renamed', 'src/old.ts')],
      'The pull request renamed this file and the base branch also touches it',
    ],
    [
      'base rename onto a path the pull changed',
      [file('src/new.ts', 'renamed', 'src/old.ts')],
      [file('src/new.ts', 'modified')],
      'The base branch renamed this file while the pull request changed it',
    ],
    [
      'type change on base',
      [file('link', 'changed')],
      [file('link', 'modified')],
      'The file type changed on the base branch',
    ],
    [
      'type change on the pull',
      [file('link', 'modified')],
      [file('link', 'changed')],
      'The file type changed on the pull request',
    ],
  ];
  test.each(refusals)('refuses %s', (_name, baseChanges, headChanges, why) => {
    expect(planMerge({ baseChanges, headChanges }, 'base')).toEqual([
      {
        kind: 'unsupported',
        path: headChanges[0]?.filename ?? '',
        reason: `${why} — resolve with git locally.`,
      },
    ]);
    // Planned the other way round, the same pair still refuses.
    expect(
      planMerge({ baseChanges, headChanges }, 'head').map((plan) => plan.kind)
    ).toContain('unsupported');
  });

  test('an uncontested pull type change takes head', () => {
    expect(
      planMerge(
        { baseChanges: [], headChanges: [file('link', 'changed')] },
        'base'
      )
    ).toEqual([{ kind: 'take-head', path: 'link' }]);
  });

  test('an uncontested pull rename becomes take-head plus delete', () => {
    expect(
      planMerge(
        {
          baseChanges: [file('unrelated.ts', 'modified')],
          headChanges: [file('src/new-name.ts', 'renamed', 'src/old-name.ts')],
        },
        'base'
      )
    ).toEqual([
      { kind: 'take-head', path: 'src/new-name.ts' },
      { kind: 'delete', path: 'src/old-name.ts' },
    ]);
  });

  test('a pull copy of a file base modified is just an add', () => {
    expect(
      planMerge(
        {
          baseChanges: [file('src/a.ts', 'modified')],
          headChanges: [file('src/b.ts', 'copied', 'src/a.ts')],
        },
        'base'
      )
    ).toEqual([{ kind: 'take-head', path: 'src/b.ts' }]);
  });

  test('onto head, base-only changes become take-base and deletes', () => {
    expect(
      planMerge(
        {
          baseChanges: [
            file('docs/new.md', 'added'),
            file('src/new-name.ts', 'renamed', 'src/old-name.ts'),
          ],
          headChanges: [file('src/app.ts', 'modified')],
        },
        'head'
      )
    ).toEqual([
      { kind: 'take-base', path: 'docs/new.md' },
      { kind: 'take-base', path: 'src/new-name.ts' },
      { kind: 'delete', path: 'src/old-name.ts' },
    ]);
  });

  test('a copy on either side never counts as removing its source', () => {
    const inputs = {
      baseChanges: [file('src/a.ts', 'modified')],
      headChanges: [file('src/b.ts', 'copied', 'src/a.ts')],
    };
    expect(planMerge(inputs, 'head')).toEqual([
      { kind: 'take-base', path: 'src/a.ts' },
    ]);
  });

  test("merge plans carry each tip's blob SHA in either direction", () => {
    const inputs = {
      baseChanges: [{ ...file('a.ts', 'modified'), sha: 'base-blob' }],
      headChanges: [{ ...file('a.ts', 'modified'), sha: 'head-blob' }],
    };
    for (const onto of ['base', 'head'] as const) {
      expect(planMerge(inputs, onto)).toEqual([
        {
          addAdd: false,
          baseBlob: 'base-blob',
          headBlob: 'head-blob',
          kind: 'merge',
          path: 'a.ts',
        },
      ]);
    }
  });

  test('mergePaths includes rename and copy sources', () => {
    expect(
      mergePaths([
        file('a.ts', 'modified'),
        file('b.ts', 'renamed', 'old-b.ts'),
      ])
    ).toEqual(['a.ts', 'b.ts', 'old-b.ts']);
  });

  // Trees as path → contents maps. Applies plans to the tree they were
  // planned onto; a merge stands in for diff3, which yields the shared
  // content when both sides agree.
  function applyPlans(
    plans: ReturnType<typeof planMerge>,
    onto: MergeOnto,
    trees: { base: Map<string, string>; head: Map<string, string> }
  ): Map<string, string> {
    const result = new Map(trees[onto]);
    for (const plan of plans) {
      if (plan.kind === 'delete') {
        result.delete(plan.path);
      } else if (plan.kind === 'take-base' || plan.kind === 'take-head') {
        const source = plan.kind === 'take-base' ? trees.base : trees.head;
        result.set(plan.path, source.get(plan.path) ?? '<missing>');
      } else if (plan.kind === 'merge') {
        const ours = trees.head.get(plan.path);
        result.set(
          plan.path,
          ours != null && ours === trees.base.get(plan.path) ? ours : '<merge>'
        );
      }
    }
    return result;
  }

  function changesBetween(
    from: Map<string, string>,
    to: Map<string, string>
  ): CompareFile[] {
    const paths = new Set([...from.keys(), ...to.keys()]);
    return [...paths].sort().flatMap((path) => {
      const before = from.get(path);
      const after = to.get(path);
      if (before === after) {
        return [];
      }
      return [
        file(
          path,
          before == null ? 'added' : after == null ? 'removed' : 'modified'
        ),
      ];
    });
  }

  // The textbook three-way rule per path, or 'unsupported' for delete/modify.
  function expectedMerge(
    mergeBase: Map<string, string>,
    base: Map<string, string>,
    head: Map<string, string>
  ): Map<string, string> | 'unsupported' {
    const result = new Map<string, string>();
    const paths = new Set([
      ...mergeBase.keys(),
      ...base.keys(),
      ...head.keys(),
    ]);
    for (const path of paths) {
      const [ancestor, theirs, ours] = [mergeBase, base, head].map((tree) =>
        tree.get(path)
      );
      let merged: string | undefined;
      if (ours === ancestor || ours === theirs) {
        merged = theirs;
      } else if (theirs === ancestor) {
        merged = ours;
      } else if (ours == null || theirs == null) {
        return 'unsupported';
      } else {
        merged = '<merge>';
      }
      if (merged != null) {
        result.set(path, merged);
      }
    }
    return result;
  }

  test('plans onto either tree match the three-way merge rule', () => {
    let seed = 7;
    const random = () =>
      (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const mutate = (tree: Map<string, string>, tag: string) => {
      const next = new Map(tree);
      for (const path of ['a', 'b', 'c', 'd', 'e']) {
        const roll = random();
        if (roll < 0.2) {
          next.delete(path);
        } else if (roll < 0.35) {
          next.set(path, `${path}-${tag}`);
        } else if (roll < 0.45) {
          // Both sides may land on the same content.
          next.set(path, `${path}-same`);
        }
      }
      return next;
    };
    for (let round = 0; round < 500; round += 1) {
      const mergeBase = new Map(
        ['a', 'b', 'c', 'd', 'e']
          .filter(() => random() < 0.7)
          .map((path) => [path, `${path}-0`] as const)
      );
      const base = mutate(mergeBase, 'base');
      const head = mutate(mergeBase, 'head');
      const inputs = {
        baseChanges: changesBetween(mergeBase, base),
        headChanges: changesBetween(mergeBase, head),
      };
      const expected = expectedMerge(mergeBase, base, head);
      for (const onto of ['base', 'head'] as const) {
        const plans = planMerge(inputs, onto);
        const refused = plans.some((plan) => plan.kind === 'unsupported');
        expect(refused).toBe(expected === 'unsupported');
        if (expected !== 'unsupported') {
          expect(applyPlans(plans, onto, { base, head })).toEqual(expected);
        }
      }
    }
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

  // node-diff3's LCS went roughly cubic on inputs like this and hung the
  // server; the Myers-based merge should finish in milliseconds.
  test('large files with many repeated lines merge quickly', () => {
    const baseLines = Array.from({ length: 60_000 }, (_, index) =>
      index % 3 === 0 ? '' : index % 3 === 1 ? '}' : `line ${index}`
    );
    const oursLines = [...baseLines];
    oursLines.splice(100, 5, 'ours');
    const theirsLines = [...baseLines];
    theirsLines.splice(30_000, 3, 'theirs');
    const startedAt = performance.now();
    const result = renderConflictMarkers(
      baseLines.join('\n'),
      oursLines.join('\n'),
      theirsLines.join('\n'),
      LABELS
    );
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(result.conflictCount).toBe(0);
    expect(result.text.split('\n')).toEqual(
      (() => {
        const expected = [...oursLines];
        expected.splice(30_000 - 4, 3, 'theirs');
        return expected;
      })()
    );
  });

  // Workers freeze Date.now() during synchronous execution, so the merge must
  // stay bounded without a clock. Wholly rewritten sides exceed the edit cap
  // and fall back to one coarse hunk instead of a quadratic Myers run.
  test('wholly rewritten files stay fast with a frozen clock', () => {
    const lines = (prefix: string) =>
      Array.from({ length: 20_000 }, (_, index) => `${prefix} ${index}`);
    const realNow = Date.now;
    const frozenAt = realNow();
    Date.now = () => frozenAt;
    try {
      const startedAt = performance.now();
      const result = renderConflictMarkers(
        lines('base').join('\n'),
        lines('ours').join('\n'),
        lines('theirs').join('\n'),
        LABELS
      );
      expect(performance.now() - startedAt).toBeLessThan(1000);
      expect(result.conflictCount).toBe(1);
    } finally {
      Date.now = realNow;
    }
  });
});

describe('diff3Merge', () => {
  const base = ['start', 'm1', 'm2', 'm3', 'm4', 'm5', 'end'];
  const ours = ['start', 'x1', 'm2', 'm3', 'm4', 'x5', 'end'];

  test('a side over the edit cap still merges cleanly against an untouched side', () => {
    expect(diff3Merge(ours, base, base, 1)).toEqual([{ ok: ours }]);
  });

  test('a side over the edit cap becomes one hunk spanning its trimmed middle', () => {
    const theirs = ['start', 'm1', 'm2', 'y3', 'm4', 'm5', 'end'];
    // Under the cap the edits are disjoint and merge without conflict.
    expect(diff3Merge(ours, base, theirs)).toEqual([
      { ok: ['start', 'x1', 'm2', 'y3', 'm4', 'x5', 'end'] },
    ]);
    // Over the cap, ours collapses to one hunk covering m1..m5, so theirs'
    // edit inside it conflicts.
    expect(diff3Merge(ours, base, theirs, 1)).toEqual([
      { ok: ['start'] },
      {
        conflict: {
          a: ['x1', 'm2', 'm3', 'm4', 'x5'],
          b: ['m1', 'm2', 'y3', 'm4', 'm5'],
          o: ['m1', 'm2', 'm3', 'm4', 'm5'],
        },
      },
      { ok: ['end'] },
    ]);
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
