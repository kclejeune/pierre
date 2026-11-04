'use client';

import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useSyncExternalStore,
} from 'react';

import { Command } from './Command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './Dialog';

interface PaletteDialogProps {
  open: boolean;
  // Fired for every open/close transition: the shortcut toggle, Radix's own
  // dismissals (Escape, overlay click), and item selection all funnel through
  // it, so callers reset per-open state (query, cached lists) here instead of
  // in an effect. `initialQuery` is set when an openPalette caller hands the
  // palette text to start with.
  onOpenChange(open: boolean, initialQuery?: string): void;
  paletteId: PaletteId;
  // Toggled by cmd/ctrl + this key, with shift/alt combinations left to the
  // browser.
  shortcutKey: string;
  title: string;
  description: string;
  children: ReactNode;
  // Props for the wrapping cmdk Command, e.g. a controlled highlighted value
  // or a keydown handler for palette-specific shortcuts.
  commandProps?: Omit<ComponentProps<typeof Command>, 'children'>;
  footer?: ReactNode;
}

export type PaletteId = 'command' | 'file' | 'repo-scope';
const OPEN_PALETTE_EVENT = 'diffshub:open-palette';

// Which palette each shortcut key opens. Palettes claim their key on mount
// and the most recent claim wins, so a page-level palette (the /pulls repo
// switcher) can take over cmd+K from the global diff switcher while that
// page is mounted, handing it back on unmount.
const shortcutClaims = new Map<string, PaletteId[]>();
const claimListeners = new Set<() => void>();

function claimShortcut(key: string, paletteId: PaletteId): () => void {
  shortcutClaims.set(key, [...(shortcutClaims.get(key) ?? []), paletteId]);
  claimListeners.forEach((listener) => listener());
  return () => {
    const claims = shortcutClaims.get(key) ?? [];
    const index = claims.lastIndexOf(paletteId);
    if (index >= 0) {
      shortcutClaims.set(
        key,
        claims.filter((_, position) => position !== index)
      );
    }
    claimListeners.forEach((listener) => listener());
  };
}

function shortcutOwner(key: string): PaletteId | undefined {
  return shortcutClaims.get(key)?.at(-1);
}

function subscribeToClaims(listener: () => void): () => void {
  claimListeners.add(listener);
  return () => claimListeners.delete(listener);
}

// Whether `paletteId` currently answers its shortcut, for triggers that show
// the shortcut as a hint. True during SSR, where no page palette has claimed
// anything yet.
export function useOwnsShortcut(key: string, paletteId: PaletteId): boolean {
  return useSyncExternalStore(
    subscribeToClaims,
    () => (shortcutOwner(key) ?? paletteId) === paletteId,
    () => true
  );
}

interface OpenPaletteDetail {
  initialQuery?: string;
  paletteId: PaletteId;
}

// Opens `paletteId` (closing any other open palette), optionally starting it
// on `initialQuery`, e.g. the /pulls repo switcher handing its text to the
// diff switcher.
export function openPalette(paletteId: PaletteId, initialQuery?: string): void {
  window.dispatchEvent(
    new CustomEvent<OpenPaletteDetail>(OPEN_PALETTE_EVENT, {
      detail: { initialQuery, paletteId },
    })
  );
}

// The shared shell of the command palettes (cmd+K diff switcher, cmd+P
// go-to-file): the global shortcut listener and the top-anchored dialog
// wrapping an unfiltered Command — every palette ranks its own results, so
// cmdk's built-in fuzzy filter stays off.
export function PaletteDialog({
  children,
  commandProps,
  description,
  footer,
  onOpenChange,
  open,
  paletteId,
  shortcutKey,
  title,
}: PaletteDialogProps) {
  // Separate from the listener effect below, whose dependencies change on
  // every open: re-claiming there would reorder the claim stack.
  useEffect(
    () => claimShortcut(shortcutKey, paletteId),
    [paletteId, shortcutKey]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        shortcutOwner(shortcutKey) === paletteId &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key === shortcutKey
      ) {
        event.preventDefault();
        if (open) {
          onOpenChange(false);
        } else {
          openPalette(paletteId);
        }
      }
    };
    const onOpenRequest = (event: Event) => {
      const { initialQuery, paletteId: requested } = (
        event as CustomEvent<OpenPaletteDetail>
      ).detail;
      if (requested === paletteId) {
        onOpenChange(true, initialQuery);
      } else {
        onOpenChange(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpenRequest);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpenRequest);
    };
  }, [onOpenChange, open, paletteId, shortcutKey]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[20%] translate-y-0 overflow-hidden p-0"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Command {...commandProps} shouldFilter={false}>
          {children}
        </Command>
        {footer}
      </DialogContent>
    </Dialog>
  );
}
