'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';

import type { PaletteEntry } from '@/lib/paletteItems';

// An entry a page contributes to the palette, with what running it does.
export interface PaletteRunnableEntry extends PaletteEntry {
  run(): void;
}

// What the page on screen tells the command palette (mounted once in
// RootLayout, outside every page): which repository it shows, so cmd+K
// opens on that repository's pull requests or refs; what picking a
// repository does here; and the page's own scopes and commands.
export interface CommandPaletteContextValue {
  // "owner/name" the page shows. The palette opens on it.
  repo?: string;
  // Which of the repository's lists leads: pull requests on a pull's diff,
  // refs elsewhere.
  prefer?: 'pulls' | 'refs';
  // What the page is showing, marked "Current" in the palette's lists.
  currentPull?: number;
  currentRef?: string;
  // Replaces stepping into a picked repository: /pulls scopes its list to
  // it, /browse opens its refs.
  onSelectRepo?(repo: string): void;
  // The footer's label for Enter on a repository row when onSelectRepo is
  // set ("View pull requests", "Open").
  selectRepoLabel?: string;
  // Top-level entries shown before the repositories while the query is
  // empty (the /pulls scopes).
  scopes?: readonly PaletteRunnableEntry[];
  commands?: readonly PaletteRunnableEntry[];
}

interface ContextSlot {
  value: CommandPaletteContextValue;
}

// Mounted pages' contexts, most recently mounted last; the last one is the
// palette's. A stack rather than a single slot so a nested or overlapping
// mount (route transitions render both pages briefly) hands back cleanly.
const slots: ContextSlot[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function currentContext(): CommandPaletteContextValue | undefined {
  return slots.at(-1)?.value;
}

// Registers `value` as the palette's context while the calling component is
// mounted. Pass a memoized value: each new object re-renders the palette.
export function useCommandPaletteContext(
  value: CommandPaletteContextValue
): void {
  const slot = useRef<ContextSlot | null>(null);
  useEffect(() => {
    const entry: ContextSlot = { value };
    slot.current = entry;
    slots.push(entry);
    notify();
    return () => {
      const index = slots.indexOf(entry);
      if (index >= 0) {
        slots.splice(index, 1);
      }
      slot.current = null;
      notify();
    };
    // Registered once per mount; updates go through the effect below.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (slot.current != null && slot.current.value !== value) {
      slot.current.value = value;
      notify();
    }
  }, [value]);
}

// The context of the page on screen, for the palette.
export function useCurrentPaletteContext():
  | CommandPaletteContextValue
  | undefined {
  return useSyncExternalStore(subscribe, currentContext, () => undefined);
}
