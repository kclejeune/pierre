// Decides what the diff URL bar should suggest for the current input. Only
// bare shorthand ("owner", "owner/rep", "owner/repo#12") gets suggestions —
// anything that looks like a URL (protocol, dotted first segment) is left
// alone, since the user is pasting rather than browsing.

export type SuggestQuery =
  // Repository-name completion while the owner and/or repo is being typed.
  | { kind: 'repos'; owner: string | null; query: string }
  // Open-pull-request completion once "owner/repo" is complete; filter is the
  // partial pull number or title text typed after the separator.
  | { kind: 'pulls'; owner: string; repo: string; filter: string };

const OWNER_PATTERN = /^([A-Za-z0-9-]{2,})$/;
const OWNER_REPO_PATTERN = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]*)$/;
const PULLS_PATTERN = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)[#/](.*)$/;

export function deriveSuggestQuery(input: string): SuggestQuery | null {
  const trimmed = input.trim();
  if (trimmed === '' || /\s/.test(trimmed) || trimmed.includes('://')) {
    return null;
  }

  if (OWNER_PATTERN.test(trimmed)) {
    return { kind: 'repos', owner: null, query: trimmed };
  }

  const pullsMatch = PULLS_PATTERN.exec(trimmed);
  if (pullsMatch != null) {
    // "owner/repo/pull/123" and friends are already full paths; only bare
    // "#…" or a plain numeric segment count as PR completion.
    const filter = pullsMatch[3];
    if (filter.includes('/')) {
      return null;
    }
    return {
      kind: 'pulls',
      owner: pullsMatch[1],
      repo: pullsMatch[2],
      filter,
    };
  }

  const ownerRepoMatch = OWNER_REPO_PATTERN.exec(trimmed);
  if (ownerRepoMatch != null) {
    return {
      kind: 'repos',
      owner: ownerRepoMatch[1],
      query: ownerRepoMatch[2],
    };
  }

  return null;
}

export interface PullSuggestion {
  number: number;
  title: string;
}

// Client-side narrowing of the fetched open-PR list as the user keeps typing
// after "owner/repo#": digits narrow by number prefix, text by title.
export function filterPullSuggestions(
  pulls: PullSuggestion[],
  filter: string
): PullSuggestion[] {
  const trimmed = filter.trim().toLowerCase();
  if (trimmed === '') {
    return pulls;
  }
  if (/^\d+$/.test(trimmed)) {
    return pulls.filter((pull) => String(pull.number).startsWith(trimmed));
  }
  return pulls.filter((pull) => pull.title.toLowerCase().includes(trimmed));
}
