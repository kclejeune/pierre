'use client';

import { type ReactNode, useEffect } from 'react';

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
  // in an effect.
  onOpenChange(open: boolean): void;
  paletteId: PaletteId;
  // Toggled by cmd/ctrl + this key, with shift/alt combinations left to the
  // browser.
  shortcutKey: string;
  title: string;
  description: string;
  children: ReactNode;
}

export type PaletteId = 'command' | 'file';
const OPEN_PALETTE_EVENT = 'diffshub:open-palette';

export function openPalette(paletteId: PaletteId): void {
  window.dispatchEvent(
    new CustomEvent<PaletteId>(OPEN_PALETTE_EVENT, { detail: paletteId })
  );
}

// The shared shell of the command palettes (cmd+K diff switcher, cmd+P
// go-to-file): the global shortcut listener and the top-anchored dialog
// wrapping an unfiltered Command — every palette ranks its own results, so
// cmdk's built-in fuzzy filter stays off.
export function PaletteDialog({
  children,
  description,
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
      const requested = (event as CustomEvent<PaletteId>).detail;
      onOpenChange(requested === paletteId);
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
        <Command shouldFilter={false}>{children}</Command>
      </DialogContent>
    </Dialog>
  );
}
