// User-configurable auto-collapse patterns: files whose repo path matches any
// pattern load collapsed (generated code, vendored trees, lockfiles). Patterns
// are root-relative globs — `**` crosses directory separators, `*` and `?`
// stay within one segment — and a pattern with no glob characters matches as
// a directory prefix, so plain `vendor` collapses everything under vendor/.
// The list is a personal viewer preference (not per-repo), so it persists
// as one synced preference (lib/preferenceSync), so it follows signed-in
// viewers across browsers.

import { readSyncedItem, writeSyncedItem } from './preferenceSync';

export function parseCollapsePatterns(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== '' && !pattern.startsWith('#'));
}

export function compileCollapsePatterns(patterns: string[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    const regExp = compileCollapsePattern(pattern);
    if (regExp != null) {
      compiled.push(regExp);
    }
  }
  return compiled;
}

export function matchesCollapsePattern(
  path: string,
  patterns: readonly RegExp[]
): boolean {
  return patterns.some((pattern) => pattern.test(path));
}

function compileCollapsePattern(pattern: string): RegExp | null {
  const normalized = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
  if (normalized === '') {
    return null;
  }
  let source = '';
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        index++;
        source += '.*';
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExpChar(char ?? '');
    }
  }
  // Literal patterns double as directory prefixes; glob patterns must match
  // the full path (write `vendor/**` for subtrees explicitly).
  const suffix = /[*?]/.test(normalized) ? '$' : '(?:/.*)?$';
  try {
    return new RegExp(`^${source}${suffix}`);
  } catch {
    return null;
  }
}

function escapeRegExpChar(char: string): string {
  return /[\\^$.|+()[\]{}]/.test(char) ? `\\${char}` : char;
}

export function loadCollapsePatternsText(): string {
  return readSyncedItem('collapsePatterns') ?? '';
}

export function saveCollapsePatternsText(text: string): void {
  writeSyncedItem('collapsePatterns', text.trim() === '' ? null : text);
}
