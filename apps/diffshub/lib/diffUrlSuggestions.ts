// The open pull requests the command palette lists inside a repository.

export interface PullSuggestion {
  number: number;
  title: string;
}

// Client-side narrowing of the fetched open-PR list as the user types:
// digits narrow by number prefix, text by title.
export function filterPullSuggestions(
  pulls: readonly PullSuggestion[],
  filter: string
): readonly PullSuggestion[] {
  const trimmed = filter.trim().toLowerCase();
  if (trimmed === '') {
    return pulls;
  }
  if (/^\d+$/.test(trimmed)) {
    return pulls.filter((pull) => String(pull.number).startsWith(trimmed));
  }
  return pulls.filter((pull) => pull.title.toLowerCase().includes(trimmed));
}
