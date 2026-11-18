'use client';

import { useCallback, useMemo, useState } from 'react';

import { useLatestValueRef } from './useLatestValueRef';
import { pullKey, type PullSummary } from '@/lib/githubPullSummaries';
import type { PullRow } from '@/lib/pullGroups';

interface PullSelection {
  // The checked pulls: those still in the list first (in list order, with
  // their current row data), then any the list no longer holds.
  checked: PullSummary[];
  // Every loaded pull is checked (pulls kept from earlier pages don't
  // count), so there's nothing left for "Select all" to add.
  allLoadedChecked: boolean;
  // Every pull the row covers is checked (a collapsed group's lead covers
  // the whole group).
  isRowChecked(row: PullRow): boolean;
  // The callbacks below keep their identity across renders, so memoized rows
  // only re-render when their own state changes. While `locked`, clear and
  // toggleRow do nothing.
  clear(): void;
  // Replaces the selection, e.g. with the pulls a batch failed on. With
  // `forSearch`, only if the list still shows that search (a batch that
  // finishes after the viewer moved on doesn't reach into the new list).
  set(pulls: readonly PullSummary[], forSearch?: string): void;
  // Flips the row with this pull key; with shift, every row from the last
  // one flipped to this one takes its new state.
  toggleRow(key: string, shiftKey: boolean): void;
}

interface SelectionState {
  // The last row flipped without shift, where a shift-click range starts.
  anchor: string | null;
  // Checked pulls by pullKey(). Pulls are kept, not just keys, so a pull
  // stays selected after a refetch drops it from the loaded pages (a
  // refresh after a batch reloads only the first page, and the pulls the
  // batch failed on must stay selected for a retry).
  picked: ReadonlyMap<string, PullSummary>;
  // The search this selection belongs to.
  resetKey: string;
}

function emptySelection(resetKey: string): SelectionState {
  return { anchor: null, picked: new Map(), resetKey };
}

// The /pulls list's batch selection: which rows are checked for the batch
// bar's approve and merge. A new `resetKey` (the list's search) starts from
// nothing checked, and returning to an earlier search doesn't bring its old
// selection back. `locked` freezes the selection while a batch runs.
export function usePullSelection(
  pulls: readonly PullSummary[],
  rows: readonly PullRow[],
  resetKey: string,
  locked: boolean
): PullSelection {
  const [stored, setStored] = useState(() => emptySelection(resetKey));
  // A search change resets the stored state itself (during render, React's
  // pattern for state derived from a prop), so the old picks are gone rather
  // than hidden.
  let state = stored;
  if (stored.resetKey !== resetKey) {
    state = emptySelection(resetKey);
    setStored(state);
  }
  const { picked } = state;
  const latest = useLatestValueRef({ locked, resetKey, rows });

  const toggleRow = useCallback(
    (key: string, shiftKey: boolean) => {
      const { locked, rows } = latest.current;
      if (locked) {
        return;
      }
      setStored((previous) => {
        const index = rows.findIndex((row) => pullKey(row.pull) === key);
        const row = rows[index];
        if (row == null) {
          return previous;
        }
        const value = !row.covers.every((pull) =>
          previous.picked.has(pullKey(pull))
        );
        const from =
          shiftKey && previous.anchor != null
            ? rows.findIndex((entry) => pullKey(entry.pull) === previous.anchor)
            : -1;
        const range =
          from === -1
            ? [row]
            : rows.slice(Math.min(from, index), Math.max(from, index) + 1);
        const next = new Map(previous.picked);
        for (const pull of range.flatMap((entry) => entry.covers)) {
          if (value) {
            next.set(pullKey(pull), pull);
          } else {
            next.delete(pullKey(pull));
          }
        }
        return { ...previous, anchor: key, picked: next };
      });
    },
    [latest]
  );

  const clear = useCallback(() => {
    if (!latest.current.locked) {
      setStored(emptySelection(latest.current.resetKey));
    }
  }, [latest]);
  const set = useCallback(
    (next: readonly PullSummary[], forSearch?: string) => {
      const { resetKey } = latest.current;
      if (forSearch != null && forSearch !== resetKey) {
        return;
      }
      setStored({
        anchor: null,
        picked: new Map(next.map((pull) => [pullKey(pull), pull])),
        resetKey,
      });
    },
    [latest]
  );
  const { allLoadedChecked, checked } = useMemo(() => {
    const inList = pulls.filter((pull) => picked.has(pullKey(pull)));
    const listed = new Set(inList.map(pullKey));
    return {
      allLoadedChecked: pulls.length > 0 && inList.length === pulls.length,
      checked: [
        ...inList,
        ...[...picked.values()].filter((pull) => !listed.has(pullKey(pull))),
      ],
    };
  }, [picked, pulls]);

  return {
    allLoadedChecked,
    checked,
    clear,
    isRowChecked: (row) =>
      row.covers.every((pull) => picked.has(pullKey(pull))),
    set,
    toggleRow,
  };
}
