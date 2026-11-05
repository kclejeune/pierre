// The /pulls query bar's GitHub search syntax: a tokenizer shared by the
// bar's syntax highlighting and the server's search builder, plus the pure
// edits the page's controls make to the typed text (the Open/Closed/Merged
// toggle rewrites `is:` state qualifiers, the sort menu rewrites `sort:`).
// Everything here is string-in, string-out so it stays unit-testable.

export interface PullQueryToken {
  kind: 'qualifier' | 'text' | 'operator' | 'paren' | 'space';
  // The exact source slice, so joining every token's raw text reproduces
  // the input (the highlighter relies on this to line up with the caret).
  raw: string;
  // Qualifiers only: "-label:bug" → negated, key "label", value "bug" (quotes
  // kept, since "label:\"good first issue\"" is one value).
  key?: string;
  negated?: boolean;
  value?: string;
}

// Qualifiers GitHub's pull request search understands. Anything else typed
// as key:value is still sent (GitHub treats it as text), but the bar flags it
// so a typo like "lable:bug" is visible before the search comes back empty.
export const KNOWN_PULL_QUALIFIERS: ReadonlySet<string> = new Set([
  'archived',
  'assignee',
  'author',
  'base',
  'closed',
  'commenter',
  'comments',
  'created',
  'draft',
  'head',
  'in',
  'interactions',
  'involves',
  'is',
  'label',
  'language',
  'linked',
  'mentions',
  'merged',
  'milestone',
  'no',
  'org',
  'project',
  'reactions',
  'repo',
  'review',
  'review-requested',
  'reviewed-by',
  'sort',
  'state',
  'status',
  'team',
  'team-review-requested',
  'updated',
  'user',
  'user-review-requested',
]);

const OPERATORS = new Set(['AND', 'OR', 'NOT']);

// One pass over the input: runs of whitespace, parens, and words (a word runs
// to the next unquoted whitespace or paren, so `label:"a b"` stays whole).
export function tokenizePullQuery(text: string): PullQueryToken[] {
  const tokens: PullQueryToken[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      let end = index + 1;
      while (end < text.length && /\s/.test(text[end])) {
        end += 1;
      }
      tokens.push({ kind: 'space', raw: text.slice(index, end) });
      index = end;
      continue;
    }
    if (char === '(' || char === ')') {
      tokens.push({ kind: 'paren', raw: char });
      index += 1;
      continue;
    }
    let end = index;
    let quoted = false;
    while (end < text.length) {
      const next = text[end];
      if (next === '"') {
        quoted = !quoted;
      } else if (!quoted && (/\s/.test(next) || next === '(' || next === ')')) {
        break;
      }
      end += 1;
    }
    tokens.push(classifyWord(text.slice(index, end)));
    index = end;
  }
  return tokens;
}

function classifyWord(raw: string): PullQueryToken {
  if (OPERATORS.has(raw)) {
    return { kind: 'operator', raw };
  }
  const match = /^(-?)([A-Za-z][A-Za-z-]*):([\s\S]*)$/.exec(raw);
  if (match == null) {
    return { kind: 'text', raw };
  }
  const [, negation, key, value] = match;
  return {
    kind: 'qualifier',
    raw,
    key: key.toLowerCase(),
    negated: negation === '-',
    value,
  };
}

// Whether `token` is a non-negated qualifier whose key is in `keys`: the
// terms the toggles and the server treat as the text's own filter.
function isPositiveQualifier(
  token: PullQueryToken,
  keys: ReadonlySet<string>
): boolean {
  return (
    token.kind === 'qualifier' &&
    keys.has(token.key ?? '') &&
    token.negated !== true
  );
}

// Values of every non-negated qualifier whose key is in `keys`, in order.
function qualifierValues(
  tokens: readonly PullQueryToken[],
  keys: ReadonlySet<string>
): string[] {
  return tokens
    .filter((token) => isPositiveQualifier(token, keys))
    .map((token) => token.value ?? '');
}

// Whether the text has a `key:` qualifier at all, negated or not (the
// server leaves archived repos to any archived: term the user typed).
export function hasQualifier(text: string, key: string): boolean {
  return tokenizePullQuery(text).some(
    (token) => token.kind === 'qualifier' && token.key === key
  );
}

const isOrToken = (token: PullQueryToken | undefined) =>
  token?.kind === 'operator' && token.raw === 'OR';
const isOpenParen = (token: PullQueryToken | undefined) =>
  token?.kind === 'paren' && token.raw === '(';
const isCloseParen = (token: PullQueryToken | undefined) =>
  token?.kind === 'paren' && token.raw === ')';

// Whether `tokens` has an OR outside every parenthesized group. Only such an
// OR needs wrapping before more terms are appended: "(a OR b) is:open"
// already scopes its OR, and wrapping it again on every edit would pile up
// nesting until GitHub's five-level limit rejects the search.
function hasTopLevelOr(tokens: readonly PullQueryToken[]): boolean {
  let depth = 0;
  for (const token of tokens) {
    if (isOpenParen(token)) {
      depth += 1;
    } else if (isCloseParen(token)) {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && isOrToken(token)) {
      return true;
    }
  }
  return false;
}

// Whether the text has an OR outside any group (an "OR" inside a quoted
// value is just text), so appending terms would only bind its last branch.
export function hasOrOperator(text: string): boolean {
  return hasTopLevelOr(tokenizePullQuery(text));
}

const NARROWING_KEYS: ReadonlySet<string> = new Set(['repo', 'org', 'user']);

// Whether every result the search can match is confined to the repositories
// named by some repo:/org:/user: qualifier. Walks the boolean structure: a
// run of terms (implicit AND) narrows when any un-negated term narrows, an OR
// narrows only when every branch does, and NOT or a "-" in front of a group
// cancels it. So "is:open org:acme" narrows, while "org:acme OR is:open" and
// "is:open NOT org:acme" don't. Unbalanced parens count as not narrowing,
// since there's no reliable reading of them.
export function hasNarrowingQualifier(text: string): boolean {
  const words = tokenizePullQuery(text).filter(
    (token) => token.kind !== 'space'
  );
  let index = 0;
  let balanced = true;
  const parseConjunction = (): boolean => {
    let narrows = false;
    let negated = false;
    while (
      index < words.length &&
      !isOrToken(words[index]) &&
      !isCloseParen(words[index])
    ) {
      const token = words[index];
      index += 1;
      if (token.kind === 'operator' || token.raw === '-') {
        // NOT and a bare "-" negate the next term; AND changes nothing.
        negated = token.raw === 'NOT' || token.raw === '-';
        continue;
      }
      let termNarrows: boolean;
      if (token.kind === 'paren') {
        termNarrows = parseDisjunction();
        if (isCloseParen(words[index])) {
          index += 1;
        } else {
          balanced = false;
        }
      } else {
        termNarrows =
          isPositiveQualifier(token, NARROWING_KEYS) &&
          (token.value ?? '') !== '';
      }
      narrows ||= termNarrows && !negated;
      negated = false;
    }
    return narrows;
  };
  const parseDisjunction = (): boolean => {
    let narrows = parseConjunction();
    while (isOrToken(words[index])) {
      index += 1;
      // Parse every branch even after one fails, so the walk stays in step.
      narrows = parseConjunction() && narrows;
    }
    return narrows;
  };
  const narrows = parseDisjunction();
  // A leftover token can only be a stray ")".
  return narrows && balanced && index === words.length;
}

// Rejoins tokens after some were removed, collapsing the whitespace runs
// that removal leaves behind (and any next to parens) at the token level, so
// the inside of quoted values is never touched.
function joinTokens(tokens: readonly PullQueryToken[]): string {
  let text = '';
  let pendingSpace = false;
  for (const token of tokens) {
    if (token.kind === 'space') {
      pendingSpace = true;
      continue;
    }
    if (
      pendingSpace &&
      text !== '' &&
      !text.endsWith('(') &&
      token.raw !== ')'
    ) {
      text += ' ';
    }
    pendingSpace = false;
    text += token.raw;
  }
  return text;
}

// Index of the nearest non-space token before/after `index`, or -1.
function neighbor(
  tokens: readonly PullQueryToken[],
  index: number,
  step: -1 | 1
): number {
  for (let at = index + step; at >= 0 && at < tokens.length; at += step) {
    if (tokens[at].kind !== 'space') {
      return at;
    }
  }
  return -1;
}

function isBinaryOperator(token: PullQueryToken | undefined): boolean {
  return token?.kind === 'operator' && token.raw !== 'NOT';
}

// The token indices to drop for the first piece of boolean structure left
// without operands: AND/OR with no operand on one side (start or end of the
// text or a group, or next to another operator), NOT with nothing after it,
// or an empty "()" group along with a NOT negating it. Empty when the
// structure is sound.
function firstDangling(tokens: readonly PullQueryToken[]): number[] {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const prev = tokens[neighbor(tokens, index, -1)] as
      | PullQueryToken
      | undefined;
    const next = tokens[neighbor(tokens, index, 1)] as
      | PullQueryToken
      | undefined;
    if (token.kind === 'operator') {
      const nothingAfter =
        next == null || next.raw === ')' || isBinaryOperator(next);
      const nothingBefore =
        prev == null || prev.raw === '(' || prev.kind === 'operator';
      if (nothingAfter || (token.raw !== 'NOT' && nothingBefore)) {
        return [index];
      }
    } else if (token.raw === '(' && next?.raw === ')') {
      const before = neighbor(tokens, index, -1);
      const group = [index, neighbor(tokens, index, 1)];
      return tokens[before]?.raw === 'NOT' ? [before, ...group] : group;
    }
  }
  return [];
}

// Drops dangling boolean structure one piece at a time, re-checking after
// each: in "a OR OR b" both ORs look dangling at once, but only one should
// go.
function pruneDanglingOperators(input: PullQueryToken[]): PullQueryToken[] {
  let tokens = input;
  for (
    let drop = firstDangling(tokens);
    drop.length > 0;
    drop = firstDangling(tokens)
  ) {
    const dropped = new Set(drop);
    tokens = tokens.filter((_, index) => !dropped.has(index));
  }
  return tokens;
}

// Removes the non-negated qualifiers keyed by `keys` whose (lowercased)
// value `matches` accepts, along with a NOT negating each one, then prunes
// the boolean structure that leaves dangling ("is:open OR is:merged" loses
// its OR too) so the result stays a valid search. Appends `replacement`
// (when given) at the end, where the typed text's own order is least
// disturbed.
function replaceQualifier(
  text: string,
  keys: ReadonlySet<string>,
  matches: (value: string) => boolean,
  replacement: string | null
): string {
  const tokens = tokenizePullQuery(text);
  const removed = new Set<number>();
  tokens.forEach((token, index) => {
    if (
      isPositiveQualifier(token, keys) &&
      matches((token.value ?? '').toLowerCase())
    ) {
      removed.add(index);
      const before = neighbor(tokens, index, -1);
      if (tokens[before]?.raw === 'NOT') {
        removed.add(before);
      }
    }
  });
  const kept = pruneDanglingOperators(
    tokens.filter((_, index) => !removed.has(index))
  );
  const base = joinTokens(kept);
  if (replacement == null) {
    return base;
  }
  if (base === '') {
    return replacement;
  }
  // "a OR b is:closed" would only close b; the replacement applies to the
  // whole search. An OR already inside a group is scoped and needs no
  // extra wrapping.
  return hasTopLevelOr(kept)
    ? `(${base}) ${replacement}`
    : `${base} ${replacement}`;
}

// The list's state toggle. 'all' drops the state qualifier entirely, which is
// how GitHub reads a search with no is:open/is:closed term.
export type PullStateFilter = 'open' | 'closed' | 'merged' | 'all';

const STATE_KEYS: ReadonlySet<string> = new Set(['is', 'state']);
const STATE_VALUES = new Set(['open', 'closed', 'merged', 'unmerged']);

export function readPullStateFilter(text: string): PullStateFilter {
  // Last one wins, matching how the toggle appends its choice.
  const state = qualifierValues(tokenizePullQuery(text), STATE_KEYS)
    .map((value) => value.toLowerCase())
    .findLast(
      (value): value is 'open' | 'closed' | 'merged' =>
        value === 'open' || value === 'closed' || value === 'merged'
    );
  return state ?? 'all';
}

export function writePullStateFilter(
  text: string,
  state: PullStateFilter
): string {
  return replaceQualifier(
    text,
    STATE_KEYS,
    (value) => STATE_VALUES.has(value),
    state === 'all' ? null : `is:${state}`
  );
}

// The sort menu's options, as GitHub `sort:` values. The empty value is the
// search's default (recently updated first), which leaves `sort:` out of the
// bar.
export const PULL_SORT_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '', label: 'Recently updated' },
  { value: 'created-desc', label: 'Newest' },
  { value: 'created-asc', label: 'Oldest' },
  { value: 'comments-desc', label: 'Most commented' },
  { value: 'updated-asc', label: 'Least recently updated' },
  { value: 'reactions-+1-desc', label: 'Most thumbs up' },
];

// The order a search runs in when the text has no sort: qualifier.
export const DEFAULT_PULL_SORT = 'updated-desc';

const SORT_KEYS: ReadonlySet<string> = new Set(['sort']);

export function readPullSort(text: string): string {
  return splitPullSort(text).sort ?? '';
}

export function writePullSort(text: string, sort: string): string {
  return replaceQualifier(
    text,
    SORT_KEYS,
    () => true,
    sort === '' ? null : `sort:${sort}`
  );
}

// Splits the typed text into its search terms and its (last, lowercased)
// sort value in one pass. The server groups the terms in parentheses when
// they contain OR, and a sort qualifier inside a group is a syntax error, so
// it has to come out.
export function splitPullSort(text: string): { rest: string; sort?: string } {
  const tokens = tokenizePullQuery(text);
  const isSort = (token: PullQueryToken) =>
    isPositiveQualifier(token, SORT_KEYS);
  const sort = tokens.filter(isSort).at(-1)?.value?.toLowerCase() ?? '';
  const rest = joinTokens(tokens.filter((token) => !isSort(token)));
  return sort === '' ? { rest } : { rest, sort };
}
