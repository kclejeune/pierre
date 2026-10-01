import { parseDiffFromFile, processFile } from '@pierre/diffs';
import { describe, expect, test } from 'bun:test';

import {
  compileDiffSearchQuery,
  type DiffSearchLine,
  type DiffSearchQuery,
  findMatchesInLine,
  forEachDiffSearchLine,
  searchDiffSources,
} from '../diffSearch';
import {
  findSymbolDefinitions,
  getDefinitionSnippet,
  getSymbolName,
} from '../symbolSearch';

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,5 @@ function outer() {
 const keep = 1;
-const oldName = 2;
+const newName = 2;
+const extra = newName;
 return keep;
 }
`;

function query(text: string, overrides: Partial<DiffSearchQuery> = {}) {
  const compiled = compileDiffSearchQuery({
    text,
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    ...overrides,
  });
  if (compiled.type !== 'pattern') {
    throw new Error(`expected a pattern for ${text}`);
  }
  return compiled.pattern;
}

function collectLines(
  fileDiff: Parameters<typeof forEachDiffSearchLine>[0]
): DiffSearchLine[] {
  const lines: DiffSearchLine[] = [];
  forEachDiffSearchLine(fileDiff, (line) => {
    lines.push(line);
  });
  return lines;
}

describe('compileDiffSearchQuery', () => {
  test('empty input compiles to nothing', () => {
    expect(
      compileDiffSearchQuery({
        text: '',
        caseSensitive: false,
        wholeWord: false,
        regex: false,
      }).type
    ).toBe('empty');
  });

  test('plain text is escaped', () => {
    expect(findMatchesInLine('a.b axb', query('a.b'))).toEqual([[0, 3]]);
  });

  test('invalid regexes report an error instead of throwing', () => {
    expect(
      compileDiffSearchQuery({
        text: '(',
        caseSensitive: false,
        wholeWord: false,
        regex: true,
      }).type
    ).toBe('error');
  });

  test('whole word treats $ and _ as identifier characters', () => {
    const pattern = query('foo', { wholeWord: true });
    expect(findMatchesInLine('foo $foo foo_ (foo)', pattern)).toEqual([
      [0, 3],
      [15, 18],
    ]);
  });

  test('case sensitivity toggles the i flag', () => {
    expect(findMatchesInLine('Foo foo', query('foo'))).toHaveLength(2);
    expect(
      findMatchesInLine('Foo foo', query('foo', { caseSensitive: true }))
    ).toEqual([[4, 7]]);
  });

  test('zero-width regex matches are skipped', () => {
    expect(findMatchesInLine('abc', query('^', { regex: true }))).toEqual([]);
  });
});

describe('forEachDiffSearchLine', () => {
  test('partial diffs yield hunk lines with real line numbers', () => {
    const fileDiff = processFile(PATCH);
    if (fileDiff == null) {
      throw new Error('failed to parse patch');
    }
    expect(collectLines(fileDiff)).toEqual([
      {
        side: 'additions',
        kind: 'context',
        lineNumber: 10,
        text: 'const keep = 1;',
      },
      {
        side: 'deletions',
        kind: 'deletion',
        lineNumber: 11,
        text: 'const oldName = 2;',
      },
      {
        side: 'additions',
        kind: 'addition',
        lineNumber: 11,
        text: 'const newName = 2;',
      },
      {
        side: 'additions',
        kind: 'addition',
        lineNumber: 12,
        text: 'const extra = newName;',
      },
      {
        side: 'additions',
        kind: 'context',
        lineNumber: 13,
        text: 'return keep;',
      },
      { side: 'additions', kind: 'context', lineNumber: 14, text: '}' },
    ]);
  });

  test('full-file diffs also yield the unchanged lines around hunks', () => {
    const oldLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`);
    const newLines = [...oldLines];
    newLines[14] = 'changed 15\n';
    const fileDiff = parseDiffFromFile(
      { name: 'f.txt', contents: oldLines.join('') },
      { name: 'f.txt', contents: newLines.join('') }
    );
    const lines = collectLines(fileDiff);
    // 30 new-side lines plus the one deleted line.
    expect(lines).toHaveLength(31);
    expect(lines[0]).toEqual({
      side: 'additions',
      kind: 'context',
      lineNumber: 1,
      text: 'line 1',
    });
    expect(lines.at(-1)).toEqual({
      side: 'additions',
      kind: 'context',
      lineNumber: 30,
      text: 'line 30',
    });
    expect(lines.filter((line) => line.kind !== 'context')).toEqual([
      { side: 'deletions', kind: 'deletion', lineNumber: 15, text: 'line 15' },
      {
        side: 'additions',
        kind: 'addition',
        lineNumber: 15,
        text: 'changed 15',
      },
    ]);
  });
});

describe('searchDiffSources', () => {
  test('reports matches with item, side, and columns, honoring the cap', () => {
    const fileDiff = processFile(PATCH);
    if (fileDiff == null) {
      throw new Error('failed to parse patch');
    }
    const sources = [{ itemId: 'src/a.ts', path: 'src/a.ts', fileDiff }];
    const { matches, truncated } = searchDiffSources(sources, query('name'));
    expect(truncated).toBe(false);
    expect(
      matches.map(({ side, lineNumber, start, end }) => [
        side,
        lineNumber,
        start,
        end,
      ])
    ).toEqual([
      ['deletions', 11, 9, 13],
      ['additions', 11, 9, 13],
      ['additions', 12, 17, 21],
    ]);
    const capped = searchDiffSources(sources, query('name'), 2);
    expect(capped.matches).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });
});

describe('symbol search', () => {
  test('getSymbolName accepts identifiers only', () => {
    expect(getSymbolName(' fooBar ')).toBe('fooBar');
    expect(getSymbolName('$el')).toBe('$el');
    expect(getSymbolName('=>')).toBeNull();
    expect(getSymbolName('"str"')).toBeNull();
  });

  test('finds declarations across common languages and skips usages', () => {
    const contents = [
      'export function loadThing(id: string) {',
      'const value = loadThing("a");',
      'class Loader {',
      '  async loadThing(id: string): Promise<void> {',
      '  }',
      '  run() {',
      '    this.loadThing(() => {',
      '  }',
      '}',
      'def loadThing(self):',
      'func (r *Repo) loadThing(id string) error {',
      'const loadThing = async (id) => id;',
      'loadThingElsewhere();',
      '',
    ].join('\n');
    const fileDiff = parseDiffFromFile(null, {
      name: 'mixed.ts',
      contents,
    });
    const definitions = findSymbolDefinitions(
      [{ itemId: 'mixed.ts', path: 'mixed.ts', fileDiff }],
      'loadThing'
    );
    expect(definitions.map((match) => match.lineNumber)).toEqual([
      1, 4, 10, 11, 12,
    ]);
    expect(definitions[0]).toMatchObject({ start: 16, end: 25 });
  });

  test('ignores definitions on deleted lines', () => {
    const fileDiff = processFile(PATCH);
    if (fileDiff == null) {
      throw new Error('failed to parse patch');
    }
    const sources = [{ itemId: 'src/a.ts', path: 'src/a.ts', fileDiff }];
    expect(findSymbolDefinitions(sources, 'oldName')).toEqual([]);
    expect(
      findSymbolDefinitions(sources, 'newName').map((m) => m.lineNumber)
    ).toEqual([11]);
  });

  test('definition snippets show the new side and mark missing lines', () => {
    const twoHunkPatch = `diff --git a/src/b.ts b/src/b.ts
index 1111111..2222222 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,2 @@
-export function helper() {
+export function helper(arg: string) {
   return 1;
@@ -5,1 +5,1 @@
-}
+};
`;
    const fileDiff = processFile(twoHunkPatch);
    if (fileDiff == null) {
      throw new Error('failed to parse patch');
    }
    const source = { itemId: 'src/b.ts', path: 'src/b.ts', fileDiff };
    const [definition] = findSymbolDefinitions([source], 'helper');
    if (definition == null) {
      throw new Error('expected a definition');
    }
    expect(getDefinitionSnippet(definition, source)).toEqual([
      {
        type: 'line',
        lineNumber: 1,
        text: 'export function helper(arg: string) {',
      },
      { type: 'line', lineNumber: 2, text: '  return 1;' },
      { type: 'gap' },
      { type: 'line', lineNumber: 5, text: '};' },
    ]);
  });
});
