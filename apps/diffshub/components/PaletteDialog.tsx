'use client';

import { type ComponentProps, type ReactNode, useEffect } from 'react';

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

export type PaletteId = 'command' | 'file';
const OPEN_PALETTE_EVENT = 'diffshub:open-palette';

interface OpenPaletteDetail {
  initialQuery?: string;
  paletteId: PaletteId;
}

// Opens `paletteId` (closing any other open palette), optionally starting it
// on `initialQuery`, e.g. a URL field handing typed text that isn't a URL to
// the command palette.
export function openPalette(paletteId: PaletteId, initialQuery?: string): void {
  window.dispatchEvent(
    new CustomEvent<OpenPaletteDetail>(OPEN_PALETTE_EVENT, {
      detail: { initialQuery, paletteId },
    })
  );
}

// Focuses the search input of the palette rendered inside `container`.
// Shared by the dialog's initial focus and controls that unmount while
// focused (the command palette's repository chip), so focus never strands on
// the dialog itself, where typing does nothing.
export function focusPaletteInput(container: Element | null): void {
  container?.querySelector<HTMLInputElement>('[cmdk-input]')?.focus();
}

// The shared shell of the command palettes (cmd+K command palette, cmd+P
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
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
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
        // Focus the search input, not whatever tabbable control renders
        // first (the command palette's repository chip sits before it).
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          focusPaletteInput(event.currentTarget as HTMLElement | null);
        }}
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
