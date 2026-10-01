import {
  type DiffLocation,
  type DiffSearchMatch,
  type DiffSearchSource,
  escapeRegExp,
  forEachDiffSearchLine,
  wrapWholeWord,
} from './diffSearch';

// Search-based "go to definition" and "find usages" for diffs. There is no
// language server behind the viewer, so a symbol is just the identifier text
// that was clicked; definitions are found by matching declaration shapes that
// most mainstream languages share (keyword + name, Go receivers, method
// signatures, arrow-function assignments) across every file in the diff.
// The results are heuristic — they can miss exotic declarations or include
// look-alikes — which is why multiple hits are listed rather than guessed.

const MAX_SYMBOL_DEFINITIONS = 200;
// Lines of context the hover preview shows around a definition.
const SNIPPET_LINES_BEFORE = 1;
const SNIPPET_LINES_AFTER = 8;

const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;

// Declaration keywords across JS/TS, Python, Rust, Go, Swift, Kotlin, Scala,
// Ruby, Elixir, C#, Java, PHP, and shell. A word only counts when it is
// directly followed by the symbol name.
const DECLARATION_KEYWORDS = [
  'abstract class',
  'class',
  'const',
  'def',
  'defmacro',
  'defmodule',
  'defp',
  'enum',
  'fn',
  'fun',
  'func',
  'function',
  'function\\*',
  'impl',
  'interface',
  'let',
  'macro_rules!',
  'module',
  'mod',
  'namespace',
  'object',
  'protocol',
  'record',
  'static',
  'struct',
  'trait',
  'type',
  'typealias',
  'typedef',
  'union',
  'val',
  'var',
];

// Modifiers that may precede a method or field name in a class body.
const MEMBER_MODIFIERS =
  '(?:(?:export|default|declare|public|private|protected|internal|static|async|readonly|override|abstract|final|virtual|get|set|pub(?:\\([^)]*\\))?|unsafe|extern|inline|const)\\s+)*';

// Returns the clicked token as a symbol name, or null when it is not an
// identifier (operators, strings, keywords like `if` are still identifiers
// lexically, so callers decide what to do with zero results).
export function getSymbolName(tokenText: string): string | null {
  const trimmed = tokenText.trim();
  return IDENTIFIER_PATTERN.test(trimmed) ? trimmed : null;
}

// Builds one pattern matching any declaration shape for a symbol name,
// compiled once per lookup rather than per line.
function createDefinitionPattern(name: string): RegExp {
  const escaped = escapeRegExp(name);
  const boundary = `(?![\\w$])`;
  const keywords = DECLARATION_KEYWORDS.join('|');
  const shapes = [
    // `function foo`, `class Foo`, `def foo`, `fn foo`, `const foo`, ...
    `(?<![\\w$.])(?:${keywords})\\s+${escaped}${boundary}`,
    // Go methods: `func (r *Repo) Foo(`.
    `\\bfunc\\s*\\([^)]*\\)\\s*${escaped}\\s*[(\\[]`,
    // Class/object members: `  async foo(a: string): Promise<void> {`.
    // Requires the line to end in an opening brace (or `:` for Python-like
    // bodies) and rejects arrow callbacks, so calls such as `foo(() => {`
    // are not mistaken for declarations.
    `^\\s*${MEMBER_MODIFIERS}${escaped}\\s*(?:<[^>]*>)?\\s*\\((?:(?!=>).)*\\)\\s*(?::[^{=]*)?(?:\\{|:)\\s*$`,
    // Assignments of functions or values in object literals and modules:
    // `foo = (a) =>`, `foo: function`, `export const foo = async () =>`.
    `^\\s*(?:export\\s+)?${escaped}\\s*(?::[^=]*)?=\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)\\s*(?::[^=]*)?=>|[\\w$]+\\s*=>)`,
    `^\\s*${escaped}\\s*:\\s*(?:async\\s+)?function\\b`,
  ];
  return new RegExp(shapes.map((shape) => `(?:${shape})`).join('|'));
}

// Whether two locations are on the same line of the same file version.
type LineIdentity = Pick<DiffLocation, 'itemId' | 'side' | 'lineNumber'>;

export function isSameLine(a: LineIdentity, b: LineIdentity): boolean {
  return (
    a.itemId === b.itemId && a.side === b.side && a.lineNumber === b.lineNumber
  );
}

// Finds lines that look like declarations of `name`. Deleted lines are
// skipped: a definition the diff removes is not where the symbol lives now.
// Each hit's column range covers the symbol name itself so the viewer
// highlights the name rather than the whole declaration.
export function findSymbolDefinitions(
  sources: Iterable<DiffSearchSource>,
  name: string,
  limit = MAX_SYMBOL_DEFINITIONS
): DiffSearchMatch[] {
  const definitionPattern = createDefinitionPattern(name);
  const namePattern = new RegExp(wrapWholeWord(escapeRegExp(name)));
  const definitions: DiffSearchMatch[] = [];
  for (const { itemId, path, fileDiff } of sources) {
    forEachDiffSearchLine(fileDiff, (line) => {
      // The substring check rejects almost every line before any regex runs.
      if (
        line.side === 'deletions' ||
        !line.text.includes(name) ||
        !definitionPattern.test(line.text)
      ) {
        return true;
      }
      const start = line.text.search(namePattern);
      if (start === -1) {
        return true;
      }
      definitions.push({
        itemId,
        path,
        side: line.side,
        kind: line.kind,
        lineNumber: line.lineNumber,
        start,
        end: start + name.length,
        lineText: line.text,
      });
      return definitions.length < limit;
    });
    if (definitions.length >= limit) {
      break;
    }
  }
  return definitions;
}

export type DefinitionSnippetLine =
  | { type: 'line'; lineNumber: number; text: string }
  | { type: 'gap' };

// The lines around a definition for the hover preview, taken from the
// definition's side of the file. Patch-only diffs can be missing some of
// those lines (they sit outside every hunk), so non-consecutive runs are
// separated by a gap marker instead of being shown as if adjacent.
export function getDefinitionSnippet(
  definition: DiffLocation,
  source: DiffSearchSource
): DefinitionSnippetLine[] {
  const first = definition.lineNumber - SNIPPET_LINES_BEFORE;
  const last = definition.lineNumber + SNIPPET_LINES_AFTER;
  const snippet: DefinitionSnippetLine[] = [];
  let previous: number | null = null;
  forEachDiffSearchLine(source.fileDiff, (line) => {
    if (line.side !== definition.side || line.lineNumber < first) {
      return true;
    }
    if (line.lineNumber > last) {
      return false;
    }
    if (previous != null && line.lineNumber !== previous + 1) {
      snippet.push({ type: 'gap' });
    }
    snippet.push({
      type: 'line',
      lineNumber: line.lineNumber,
      text: line.text,
    });
    previous = line.lineNumber;
    return true;
  });
  return snippet;
}
