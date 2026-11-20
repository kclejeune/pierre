// The /pulls query bar's GitHub search syntax: a tokenizer shared by the
// bar's syntax highlighting and the server's search builder, plus the pure
// edits the page's controls make to the typed text (the Open/Closed/Merged
// toggle rewrites `is:` state qualifiers, the sort menu rewrites `sort:`).
// Everything here is string-in, string-out so it stays unit-testable.

import { includesName } from './nameList';

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

// Whether the search excludes each qualifier token. Negation comes from a
// leading "-" on the term, a NOT before it, or a NOT or "-" before an
// enclosing group, and two negations cancel; this matches what GitHub runs
// once normalizeQualifierNegation rewrites NOT qualifiers. Unbalanced parens
// (mid-typing) have no reliable group reading, so each term then falls back
// to its own "-" and `balanced` is false.
function qualifierNegations(tokens: readonly PullQueryToken[]): {
  balanced: boolean;
  negated: Map<PullQueryToken, boolean>;
} {
  const negated = new Map<PullQueryToken, boolean>();
  // Whether each open group (and the text outside them) is negated.
  const groups: boolean[] = [];
  let groupNegated = false;
  // A NOT or bare "-" waiting for the term or group it negates.
  let pendingNot = false;
  let balanced = true;
  for (const token of tokens) {
    if (token.kind === 'space') {
      continue;
    }
    if (token.kind === 'operator' || token.raw === '-') {
      // AND and OR don't carry a negation across them.
      pendingNot = token.raw === 'NOT' || token.raw === '-';
      continue;
    }
    if (isOpenParen(token)) {
      groups.push(groupNegated);
      groupNegated = groupNegated !== pendingNot;
    } else if (isCloseParen(token)) {
      const outer = groups.pop();
      if (outer == null) {
        balanced = false;
        break;
      }
      groupNegated = outer;
    } else if (token.kind === 'qualifier') {
      negated.set(
        token,
        (groupNegated !== pendingNot) !== (token.negated === true)
      );
    }
    pendingNot = false;
  }
  if (!balanced || groups.length > 0) {
    const lexical = new Map<PullQueryToken, boolean>();
    for (const token of tokens) {
      if (token.kind === 'qualifier') {
        lexical.set(token, token.negated === true);
      }
    }
    return { balanced: false, negated: lexical };
  }
  return { balanced: true, negated };
}

// A qualifier value without its surrounding quotes: author:"svc-bump" and
// author:svc-bump name the same author.
function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

// Values of the `key:` qualifiers the text asks for rather than excludes,
// unquoted and in order (e.g. the authors an author: term requests).
// With unbalanced parens it returns nothing: muting reads this to decide
// which exclusions to lift, and keeping them is the safe reading.
export function readPositiveQualifierValues(
  text: string,
  key: string
): string[] {
  const { balanced, negated } = qualifierNegations(tokenizePullQuery(text));
  if (!balanced) {
    return [];
  }
  const values: string[] = [];
  for (const [token, isNegated] of negated) {
    if (token.key === key && !isNegated) {
      values.push(unquote(token.value ?? ''));
    }
  }
  return values;
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

// Rewrites `NOT qualifier:value` as `-qualifier:value`. GitHub's issue search
// (GHES included) applies NOT only to bare keywords: `NOT author:x` matches
// nothing, while `-author:x` excludes as intended, in groups too. NOT before
// a keyword or a group is left alone, as is a qualifier already negated.
export function normalizeQualifierNegation(text: string): string {
  const tokens = tokenizePullQuery(text);
  const out: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1]?.kind === 'space' ? index + 2 : index + 1;
    const target = tokens[next];
    if (
      token.kind === 'operator' &&
      token.raw === 'NOT' &&
      target?.kind === 'qualifier' &&
      target.negated !== true
    ) {
      out.push(`-${target.raw}`);
      index = next;
      continue;
    }
    out.push(token.raw);
  }
  return out.join('');
}

// The pull number a query names, "83" or "#83", or undefined when it isn't
// just a number.
export function readPullNumberQuery(query: string): string | undefined {
  return /^#?(\d+)$/.exec(query.trim())?.[1];
}

// Whether the text has an OR outside any group (an "OR" inside a quoted
// value is just text), so appending terms would only bind its last branch.
export function hasOrOperator(text: string): boolean {
  return hasTopLevelOr(tokenizePullQuery(text));
}

const NARROWING_KEYS: ReadonlySet<string> = new Set(['repo', 'org', 'user']);

// Whether every result the search can match is confined to the repositories
// named by some repo:/org:/user: qualifier. So "is:open org:acme" narrows,
// while "org:acme OR is:open" and "is:open NOT org:acme" don't.
export function hasNarrowingQualifier(text: string): boolean {
  return everyBranchRequires(
    text,
    (token) =>
      isPositiveQualifier(token, NARROWING_KEYS) && (token.value ?? '') !== ''
  );
}

// Whether every result the search can match must satisfy some term that
// `requires` accepts. Walks the boolean structure: a run of terms (implicit
// AND) qualifies when any un-negated term does, an OR only when every branch
// does, and NOT or a "-" in front of a group cancels it. Unbalanced parens
// count as not qualifying, since there's no reliable reading of them.
function everyBranchRequires(
  text: string,
  requires: (token: PullQueryToken) => boolean
): boolean {
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
        termNarrows = requires(token);
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
  return replaceTerms(
    text,
    (token) =>
      isPositiveQualifier(token, keys) &&
      matches((token.value ?? '').toLowerCase()),
    replacement
  );
}

// replaceQualifier's engine: drops every token `remove` accepts (and a NOT
// negating it), prunes dangling structure, and appends `replacement`.
// `remove` also gets whether the search excludes the token
// (qualifierNegations), so filter edits leave alone the terms their menus
// don't show as chosen.
function replaceTerms(
  text: string,
  remove: (token: PullQueryToken, negated: boolean, index: number) => boolean,
  replacement: string | null
): string {
  const tokens = tokenizePullQuery(text);
  const { negated } = qualifierNegations(tokens);
  const removed = new Set<number>();
  tokens.forEach((token, index) => {
    if (remove(token, negated.get(token) ?? false, index)) {
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

// A single-choice filter's term (the Author, Review, and Checks filters, and
// the dashboard's "show only their pull requests"): sets `key:value`,
// replacing any `key:` term already there. Null drops the filter.
export function writePullQualifierFilter(
  text: string,
  key: string,
  value: string | null
): string {
  return replaceTerms(
    text,
    (token, negated) =>
      token.kind === 'qualifier' && token.key === key && !negated,
    value == null ? null : `${key}:${value}`
  );
}

// The value a single-choice filter shows as chosen: the last `key:` term
// the text asks for rather than excludes, if any.
export function readPullQualifierFilter(
  text: string,
  key: string
): string | undefined {
  return readPositiveQualifierValues(text, key).at(-1);
}

// The list's Review and Checks filters: one value of GitHub's review: or
// status: qualifier at a time, the empty value meaning "any" (no term).
export const PULL_REVIEW_FILTER_OPTIONS: readonly {
  value: string;
  label: string;
}[] = [
  { value: '', label: 'Any review state' },
  { value: 'required', label: 'Review required' },
  { value: 'approved', label: 'Approved' },
  { value: 'changes_requested', label: 'Changes requested' },
  { value: 'none', label: 'No reviews' },
];

export const PULL_CHECKS_FILTER_OPTIONS: readonly {
  value: string;
  label: string;
}[] = [
  { value: '', label: 'Any checks state' },
  { value: 'success', label: 'Passing' },
  { value: 'failure', label: 'Failing' },
  { value: 'pending', label: 'Pending' },
];

// A qualifier value (a label name) as the search needs it: quoted when it
// has spaces, parens, or a colon (renovate's "renovate-manager: pep621"),
// bare otherwise. GitHub search can't escape a quote, so quotes are dropped.
export function quoteSearchValue(name: string): string {
  const clean = name.replaceAll('"', '');
  return /[\s():]/.test(clean) ? `"${clean}"` : clean;
}

// The labels the Label filter shows as chosen: names the text includes
// (label:x), excludes (-label:x), and whether it asks for unlabeled pulls
// (no:label). Names are unquoted; comparisons are case-insensitive, as on
// GitHub.
export interface PullLabelFilters {
  exclude: string[];
  include: string[];
  unlabeled: boolean;
}

export function readPullLabelFilters(text: string): PullLabelFilters {
  const filters: PullLabelFilters = {
    exclude: [],
    include: [],
    unlabeled: false,
  };
  // Negation as the search runs it, so `NOT label:bug` reads as excluded.
  const { negated } = qualifierNegations(tokenizePullQuery(text));
  for (const [token, isNegated] of negated) {
    const value = unquote(token.value ?? '');
    if (token.key === 'label' && value !== '') {
      (isNegated ? filters.exclude : filters.include).push(value);
    } else if (
      token.key === 'no' &&
      !isNegated &&
      value.toLowerCase() === 'label'
    ) {
      filters.unlabeled = true;
    }
  }
  return filters;
}

// The Label filter's click: includes `name` (or, with `exclude`, excludes
// it), or clears it when it's already in that mode. Any other term for the
// same label goes first, so a label is never both included and excluded.
export function togglePullLabelFilter(
  text: string,
  name: string,
  mode: 'exclude' | 'include'
): string {
  const lower = name.toLowerCase();
  const current = readPullLabelFilters(text);
  const inMode = includesName(
    mode === 'exclude' ? current.exclude : current.include,
    name
  );
  const term = `${mode === 'exclude' ? '-' : ''}label:${quoteSearchValue(name)}`;
  return replaceTerms(
    text,
    (token) =>
      token.kind === 'qualifier' &&
      token.key === 'label' &&
      unquote(token.value ?? '').toLowerCase() === lower,
    inMode ? null : term
  );
}

export function togglePullUnlabeledFilter(text: string): string {
  return replaceTerms(
    text,
    (token, negated) =>
      token.kind === 'qualifier' &&
      token.key === 'no' &&
      !negated &&
      (token.value ?? '').toLowerCase() === 'label',
    readPullLabelFilters(text).unlabeled ? null : 'no:label'
  );
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

// Whether the search lists only open pulls: every branch of it requires
// is:open (everyBranchRequires), and no state it names is anything else. So
// "is:merged OR is:open", "is:open OR label:bug", and "NOT is:open" don't
// count, since staleness muting would hide the history they also ask for.
export function listsOnlyOpenPulls(text: string): boolean {
  const states = qualifierValues(tokenizePullQuery(text), STATE_KEYS).map(
    (value) => value.toLowerCase()
  );
  return (
    states.every((value) => value === 'open' || !STATE_VALUES.has(value)) &&
    everyBranchRequires(
      text,
      (token) =>
        isPositiveQualifier(token, STATE_KEYS) &&
        token.value?.toLowerCase() === 'open'
    )
  );
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

// Drops GitHub's `is:pr` / `type:pr` from a search: a GitHub pull request
// list URL always carries one, and the dashboard adds is:pr to every search
// itself. Only a term ANDed with the whole search goes, where removing it
// can't change the results: one outside every group, not negated, in a
// search with no top-level OR. Anywhere else it can be what widens the
// search (`is:pr OR author:x`, or `NOT (-is:pr author:x)`, both matching
// every pull), so it stays as written.
export function stripPullTypeTerms(text: string): string {
  const tokens = tokenizePullQuery(text);
  if (hasTopLevelOr(tokens)) {
    return text.trim();
  }
  let depth = 0;
  const topLevel = tokens.map((token) => {
    if (isOpenParen(token)) {
      depth += 1;
    } else if (isCloseParen(token)) {
      depth = Math.max(0, depth - 1);
    }
    return depth === 0;
  });
  return replaceTerms(
    text,
    (token, negated, index) =>
      topLevel[index] === true &&
      token.kind === 'qualifier' &&
      !negated &&
      (token.key === 'is' || token.key === 'type') &&
      (token.value ?? '').toLowerCase() === 'pr',
    null
  );
}

// The Filters menu's "Clear filters": drops every term the presets set (an
// author, label and -label terms, no:label, review:, status:), leaving the
// rest of the typed search alone.
export function clearPullFilters(text: string): string {
  return replaceTerms(
    text,
    (token, negated) =>
      token.kind === 'qualifier' &&
      (token.key === 'label' ||
        (!negated &&
          (token.key === 'author' ||
            token.key === 'review' ||
            token.key === 'status' ||
            (token.key === 'no' &&
              (token.value ?? '').toLowerCase() === 'label')))),
    null
  );
}
