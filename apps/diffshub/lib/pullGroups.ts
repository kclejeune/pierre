// Folds near-duplicate /pulls rows into groups: pulls with the same title
// from the same author, which is what one automation run (a dependency bump,
// an owners-file sync) leaves across many repositories. The dashboard shows
// each group as its newest pull with a "+N" toggle, so six identical
// "pin dependency repoctl to 0.2.37" rows take one line until expanded.

import { pullKey, type PullSummary } from './githubPullSummaries';

export interface PullGroup {
  // Stable across refetches while the group's lead stays the same title and
  // author, so an expanded group stays expanded.
  key: string;
  // In list order; the first is the lead row.
  pulls: PullSummary[];
}

function groupKey(pull: PullSummary): string {
  return `${pull.authorLogin ?? ''}\u0000${pull.title.trim().toLowerCase()}`;
}

// Groups `pulls` (in list order) by author and title, each group placed where
// its first pull appeared. Pulls without an author never group: a deleted
// ("ghost") author says nothing about where the pulls came from.
export function groupPulls(pulls: readonly PullSummary[]): PullGroup[] {
  const groups = new Map<string, PullGroup>();
  const ordered: PullGroup[] = [];
  for (const pull of pulls) {
    const key = pull.authorLogin == null ? pullKey(pull) : groupKey(pull);
    const existing = groups.get(key);
    if (existing != null) {
      existing.pulls.push(pull);
      continue;
    }
    const group: PullGroup = { key, pulls: [pull] };
    groups.set(key, group);
    ordered.push(group);
  }
  return ordered;
}

// One row on screen: a group's lead, or (in an expanded group) one of the
// pulls listed under it.
export interface PullRow {
  pull: PullSummary;
  // The pulls the row stands for: the whole group for a collapsed lead,
  // otherwise just its own pull. Checking the row checks all of them.
  covers: readonly PullSummary[];
  group: PullGroup;
  // A lead row, which carries the group's "+N" toggle when it has company.
  lead: boolean;
}

// The rows on screen, in order: every group's lead, plus the rest of each
// expanded group. Rendering, selection, and keyboard navigation all read
// this one list.
export function buildPullRows(
  groups: readonly PullGroup[],
  expanded: ReadonlySet<string>
): PullRow[] {
  return groups.flatMap((group) => {
    const open = expanded.has(group.key);
    return (open ? group.pulls : group.pulls.slice(0, 1)).map(
      (pull, index): PullRow => ({
        pull,
        covers: index === 0 && !open ? group.pulls : [pull],
        group,
        lead: index === 0,
      })
    );
  });
}
