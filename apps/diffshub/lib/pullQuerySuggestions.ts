import {
  KNOWN_PULL_QUALIFIERS,
  PULL_SORT_OPTIONS,
  tokenizePullQuery,
} from './pullSearchQuery';

// One completion the /pulls search bar can offer, e.g. "is:open" or
// "label:". Accepting it replaces `from`..`to` of the text with `text`.
export interface QuerySuggestion {
  text: string;
  // A short gloss shown beside the text.
  detail?: string;
}

export interface QuerySuggestions {
  from: number;
  to: number;
  items: QuerySuggestion[];
}

const MAX_SUGGESTIONS = 8;

const QUALIFIER_KEYS = [...KNOWN_PULL_QUALIFIERS];

// What each qualifier filters on, shown beside key completions so the list
// doubles as a cheat sheet for GitHub's search syntax.
const QUALIFIER_DETAILS: Readonly<Record<string, string>> = {
  archived: 'archived repositories',
  assignee: 'assigned to a user',
  author: 'opened by a user',
  base: 'target branch',
  closed: 'closed on or around a date',
  commenter: 'commented on by a user',
  comments: 'number of comments',
  created: 'created on or around a date',
  draft: 'draft or ready',
  head: 'source branch',
  in: 'where the text matches',
  interactions: 'reactions plus comments',
  involves: 'any involvement by a user',
  is: 'state or type',
  label: 'has a label',
  language: 'repository language',
  linked: 'linked to an issue',
  mentions: 'mentions a user',
  merged: 'merged on or around a date',
  milestone: 'in a milestone',
  no: 'missing a field',
  org: 'in an organization',
  project: 'in a project',
  reactions: 'number of reactions',
  repo: 'in a repository',
  review: 'review status',
  'review-requested': 'review requested from a user or team',
  'reviewed-by': 'reviewed by a user',
  sort: 'result order',
  state: 'open or closed',
  status: 'commit status checks',
  team: 'mentions a team',
  'team-review-requested': 'review requested from a team',
  updated: 'updated on or around a date',
  user: 'owned by a user',
  'user-review-requested': 'review requested from a user directly',
};

const USER_QUALIFIERS = [
  'assignee',
  'author',
  'commenter',
  'involves',
  'mentions',
  'review-requested',
  'reviewed-by',
  'user-review-requested',
];

const DATE_QUALIFIERS = ['closed', 'created', 'merged', 'updated'];

// Fixed value lists per qualifier, as [value, detail] pairs.
const STATIC_VALUES: Readonly<Record<string, readonly [string, string?][]>> = {
  archived: [['false'], ['true']],
  draft: [
    ['true', 'drafts only'],
    ['false', 'ready for review'],
  ],
  in: [['title'], ['body'], ['comments']],
  is: [
    ['open'],
    ['closed'],
    ['merged'],
    ['unmerged', 'closed without merging'],
    ['draft'],
    ['locked'],
    ['unlocked'],
  ],
  linked: [['issue']],
  no: [
    ['label', 'no labels'],
    ['milestone', 'no milestone'],
    ['assignee', 'no assignee'],
    ['project', 'no project'],
  ],
  review: [
    ['none', 'no reviews yet'],
    ['required', 'review required'],
    ['approved'],
    ['changes_requested', 'changes requested'],
  ],
  sort: PULL_SORT_OPTIONS.filter((option) => option.value !== '').map(
    (option): [string, string] => [option.value, option.label.toLowerCase()]
  ),
  state: [['open'], ['closed']],
  status: [['success'], ['failure'], ['pending']],
};

const DATE_RANGES: readonly [days: number, detail: string][] = [
  [1, 'past day'],
  [7, 'past week'],
  [30, 'past month'],
  [90, 'past 3 months'],
];

// The search word the caret is in or just after: its span and the part
// typed before the caret. Word boundaries come from tokenizePullQuery (the
// same rules the highlighter and server use), so `label:"a b` with the caret
// inside the quotes is one word. Null when the caret isn't touching a word
// (start of text, after a space or paren).
export function queryWordAtCaret(
  text: string,
  caret: number
): { from: number; to: number; typed: string } | null {
  let from = 0;
  for (const token of tokenizePullQuery(text)) {
    const to = from + token.raw.length;
    if (
      caret > from &&
      caret <= to &&
      token.kind !== 'space' &&
      token.kind !== 'paren'
    ) {
      return { from, to, typed: text.slice(from, caret) };
    }
    from = to;
  }
  return null;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function quoteIfNeeded(value: string): string {
  return /[\s()]/.test(value) ? `"${value}"` : value;
}

// The value list for a qualifier key: fixed values, @me for user keys,
// recent date ranges for date keys, and the scoped repository's labels for
// `label:`.
function valuesFor(
  key: string,
  options: { labels?: readonly string[]; now: Date }
): readonly [string, string?][] {
  // Own properties only: a typed key like `constructor:` must not reach
  // Object.prototype.
  if (Object.hasOwn(STATIC_VALUES, key)) {
    return STATIC_VALUES[key];
  }
  if (USER_QUALIFIERS.includes(key)) {
    return [['@me', 'you']];
  }
  if (DATE_QUALIFIERS.includes(key)) {
    return DATE_RANGES.map(([days, detail]) => [
      `>=${formatDate(new Date(options.now.getTime() - days * 86_400_000))}`,
      detail,
    ]);
  }
  if (key === 'label') {
    // GitHub search has no escape for `"` inside a value, and an unmatched
    // quote would swallow the rest of the query, so such labels aren't
    // offered.
    return (options.labels ?? [])
      .filter((name) => !name.includes('"'))
      .map((name) => [quoteIfNeeded(name)]);
  }
  return [];
}

// Ranks candidates whose text starts with the typed fragment ahead of ones
// that only contain it, keeping each group's original order.
function rankMatches<T>(
  candidates: readonly T[],
  textOf: (candidate: T) => string,
  fragment: string
): T[] {
  const needle = fragment.toLowerCase();
  const starts: T[] = [];
  const contains: T[] = [];
  for (const candidate of candidates) {
    const text = textOf(candidate).toLowerCase();
    if (text.startsWith(needle)) {
      starts.push(candidate);
    } else if (needle !== '' && text.includes(needle)) {
      contains.push(candidate);
    }
  }
  return [...starts, ...contains];
}

// Completions for the /pulls search text at `caret`: qualifier keys while a
// bare word is being typed (`aut` -> `author:`), then that key's values
// once its colon is in (`is:` -> open, merged, draft, ...). A leading `-`
// (negation) is kept. Returns null when there's nothing useful to offer, so
// the bar can hide its list: an empty word, an unknown key, or a value
// already typed in full.
export function getQuerySuggestions(
  text: string,
  caret: number,
  options: { labels?: readonly string[]; now: Date }
): QuerySuggestions | null {
  const word = queryWordAtCaret(text, caret);
  if (word == null) {
    return null;
  }
  const { from, to, typed } = word;
  const negation = typed.startsWith('-') ? '-' : '';
  const body = typed.slice(negation.length);
  if (body === '') {
    return null;
  }
  const colon = body.indexOf(':');
  let items: QuerySuggestion[];
  if (colon === -1) {
    items = rankMatches(QUALIFIER_KEYS, (key) => key, body).map((key) => ({
      detail: QUALIFIER_DETAILS[key],
      text: `${negation}${key}:`,
    }));
  } else {
    const key = body.slice(0, colon).toLowerCase();
    const fragment = body.slice(colon + 1).replace(/^"/, '');
    const values = rankMatches(
      valuesFor(key, options),
      ([value]) => value.replace(/^"/, ''),
      fragment
    );
    items = values.map(([value, detail]) => ({
      detail,
      text: `${negation}${key}:${value}`,
    }));
  }
  // A word that's already exactly an item is finished: offering the other
  // matches would let Tab swap it for one (is:merged -> is:unmerged).
  const whole = text.slice(from, to);
  if (items.length === 0 || items.some((item) => item.text === whole)) {
    return null;
  }
  return { from, to, items: items.slice(0, MAX_SUGGESTIONS) };
}

// The text and caret after accepting `item`. A completed value gets a
// trailing space (adding one only when the next character isn't already
// whitespace) so the next qualifier can be typed straight away; a key stops
// at its colon so its values come up next.
export function applyQuerySuggestion(
  text: string,
  suggestions: Pick<QuerySuggestions, 'from' | 'to'>,
  item: QuerySuggestion
): { caret: number; text: string } {
  const before = text.slice(0, suggestions.from);
  const after = text.slice(suggestions.to);
  if (item.text.endsWith(':')) {
    return {
      caret: before.length + item.text.length,
      text: before + item.text + after,
    };
  }
  // A value brings its own trailing space, replacing one already there.
  const insert = `${item.text} `;
  return {
    caret: before.length + insert.length,
    text: before + insert + after.replace(/^\s/, ''),
  };
}
