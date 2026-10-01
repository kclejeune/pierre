'use client';

import { useStableCallback } from '@pierre/diffs/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { SymbolTarget } from './DiffsHubViewer';
import type { DiffSearchController } from './useDiffSearchController';
import type { DiffSearchMatch } from '@/lib/diffSearch';
import { getNavigateBackShortcutLabel } from '@/lib/platform';
import { splitPath } from '@/lib/splitPath';
import {
  type DefinitionSnippetLine,
  findSymbolDefinitions,
  getDefinitionSnippet,
  isSameLine,
} from '@/lib/symbolSearch';

// Delay between Cmd/Ctrl-hovering a token and showing its preview, so
// sweeping the pointer across code with the modifier held stays quiet.
const PREVIEW_DELAY_MS = 250;
// Candidates considered for the preview; the card shows the first and counts
// the rest.
const MAX_PREVIEW_DEFINITIONS = 20;
const CARD_WIDTH_PX = 560;
const CARD_MARGIN_PX = 8;
const SYMBOL_LINK_ATTRIBUTE = 'data-diffshub-symbol-link';

interface SymbolPreview {
  anchor: DOMRect;
  definitions: DiffSearchMatch[];
  name: string;
  snippet: DefinitionSnippetLine[];
}

interface SymbolHoverPreview {
  // Feed every token hover change from the viewer here.
  onSymbolHover(target: SymbolTarget | null, event: PointerEvent): void;
  // Dismisses the preview and link styling (e.g. after a click navigates).
  dismiss(): void;
  preview: ReactNode;
}

// Cmd/Ctrl-hover behavior for identifiers, modeled on editors: holding the
// modifier over an identifier underlines it as a link and, after a short
// pause, shows a card with its definition's location and surrounding lines.
// The modifier can be pressed before or after the pointer arrives; releasing
// it, moving off the token, or scrolling dismisses the card.
export function useSymbolHoverPreview(
  controller: DiffSearchController
): SymbolHoverPreview {
  const [preview, setPreview] = useState<SymbolPreview | null>(null);
  const hoveredRef = useRef<SymbolTarget | null>(null);
  const modifierRef = useRef(false);
  const linkedRef = useRef<HTMLElement | null>(null);
  const pendingRef = useRef<{ element: HTMLElement; timer: number } | null>(
    null
  );
  const shownElementRef = useRef<HTMLElement | null>(null);

  const setLinked = (element: HTMLElement | null) => {
    if (linkedRef.current === element) {
      return;
    }
    linkedRef.current?.removeAttribute(SYMBOL_LINK_ATTRIBUTE);
    element?.setAttribute(SYMBOL_LINK_ATTRIBUTE, '');
    linkedRef.current = element;
  };

  const cancelPending = useStableCallback(() => {
    if (pendingRef.current != null) {
      window.clearTimeout(pendingRef.current.timer);
      pendingRef.current = null;
    }
  });

  const hide = useStableCallback(() => {
    cancelPending();
    if (shownElementRef.current != null) {
      shownElementRef.current = null;
      setPreview(null);
    }
  });

  // Builds the card for a target: the first definition that is not the
  // hovered token itself, plus its snippet. Hovering a definition directly
  // shows nothing, since the card would only repeat the line under the
  // pointer.
  const buildPreview = (target: SymbolTarget): SymbolPreview | null => {
    const definitions = findSymbolDefinitions(
      controller.getSources(),
      target.name,
      MAX_PREVIEW_DEFINITIONS
    ).filter((definition) => !isSameLine(definition, target));
    const [first] = definitions;
    const source =
      first == null ? undefined : controller.getSource(first.itemId);
    return {
      anchor: target.element.getBoundingClientRect(),
      definitions,
      name: target.name,
      snippet:
        first == null || source == null
          ? []
          : getDefinitionSnippet(first, source),
    };
  };

  // Re-derives link styling and the preview from the hovered token and the
  // modifier state; every input event funnels through here.
  const sync = useStableCallback(() => {
    const target = hoveredRef.current;
    const active = target != null && modifierRef.current;
    setLinked(active ? target.element : null);
    if (!active) {
      hide();
      return;
    }
    if (
      shownElementRef.current === target.element ||
      pendingRef.current?.element === target.element
    ) {
      return;
    }
    cancelPending();
    pendingRef.current = {
      element: target.element,
      timer: window.setTimeout(() => {
        pendingRef.current = null;
        const current = hoveredRef.current;
        if (current?.element !== target.element || !modifierRef.current) {
          return;
        }
        shownElementRef.current = target.element;
        setPreview(buildPreview(target));
      }, PREVIEW_DELAY_MS),
    };
  });

  const onSymbolHover = useStableCallback(
    (target: SymbolTarget | null, event: PointerEvent) => {
      hoveredRef.current = target;
      modifierRef.current = event.metaKey || event.ctrlKey;
      sync();
    }
  );

  const dismiss = useStableCallback(() => {
    hoveredRef.current = null;
    sync();
  });

  useEffect(() => {
    const onModifierChange = (event: KeyboardEvent) => {
      if (event.key === 'Meta' || event.key === 'Control') {
        modifierRef.current = event.metaKey || event.ctrlKey;
        sync();
      }
    };
    const onBlur = () => {
      modifierRef.current = false;
      sync();
    };
    const listeners = new AbortController();
    const { signal } = listeners;
    window.addEventListener('keydown', onModifierChange, { signal });
    window.addEventListener('keyup', onModifierChange, { signal });
    window.addEventListener('blur', onBlur, { signal });
    // The card is anchored to where the token was, so any scroll detaches
    // it. Scroll events do not bubble; capturing at the window sees the
    // viewer's (and every other element's) scrolls, however they started.
    window.addEventListener('scroll', hide, {
      capture: true,
      passive: true,
      signal,
    });
    return () => {
      listeners.abort();
      cancelPending();
      linkedRef.current?.removeAttribute(SYMBOL_LINK_ATTRIBUTE);
    };
  }, [cancelPending, hide, sync]);

  return {
    dismiss,
    onSymbolHover,
    preview:
      preview == null
        ? null
        : createPortal(<SymbolPreviewCard preview={preview} />, document.body),
  };
}

function SymbolPreviewCard({ preview }: { preview: SymbolPreview }) {
  const { anchor, definitions, name, snippet } = preview;
  const [first] = definitions;
  const { basename, dirname } = splitPath(first?.path ?? '');
  // Open below the token unless that would run off the bottom of the
  // viewport, in which case open above it.
  const below = anchor.bottom + 260 < window.innerHeight;
  const left = Math.max(
    CARD_MARGIN_PX,
    Math.min(anchor.left, window.innerWidth - CARD_WIDTH_PX - CARD_MARGIN_PX)
  );
  return (
    <div
      role="tooltip"
      className="bg-background text-foreground pointer-events-none fixed z-50 flex max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-lg border border-[var(--color-border-opaque)] text-xs shadow-lg"
      style={{
        left,
        width: CARD_WIDTH_PX,
        ...(below
          ? { top: anchor.bottom + 4 }
          : { bottom: window.innerHeight - anchor.top + 4 }),
      }}
    >
      {first == null ? (
        <div className="text-muted-foreground px-3 py-2">
          No definition of <span className="font-mono">{name}</span> in this
          diff
        </div>
      ) : (
        <>
          <div className="text-muted-foreground flex items-center gap-2 border-b border-[var(--color-border-opaque)] px-3 py-1.5">
            {/* The file name and line lead so a long directory truncates
                instead of the part that says where the definition is. */}
            <span className="text-foreground shrink-0 font-mono">
              {basename}:{first.lineNumber}
            </span>
            <span className="min-w-0 truncate font-mono" title={first.path}>
              {dirname}
            </span>
            {definitions.length > 1 && (
              <span className="ml-auto shrink-0">
                +{definitions.length - 1} more
              </span>
            )}
          </div>
          <pre className="overflow-hidden px-3 py-2 font-mono text-[11px] leading-[18px]">
            {snippet.map((line, index) =>
              line.type === 'gap' ? (
                <div key={`gap-${index}`} className="text-muted-foreground">
                  ⋯
                </div>
              ) : (
                <div key={line.lineNumber} className="flex gap-3">
                  <span className="text-muted-foreground w-8 shrink-0 text-right tabular-nums select-none">
                    {line.lineNumber}
                  </span>
                  <span className="min-w-0 truncate whitespace-pre">
                    {line.lineNumber === first.lineNumber ? (
                      <>
                        {line.text.slice(0, first.start)}
                        <mark className="rounded-[2px] bg-orange-400/40 text-inherit">
                          {line.text.slice(first.start, first.end)}
                        </mark>
                        {line.text.slice(first.end)}
                      </>
                    ) : (
                      line.text
                    )}
                  </span>
                </div>
              )
            )}
          </pre>
        </>
      )}
      <div className="text-muted-foreground border-t border-[var(--color-border-opaque)] px-3 py-1 text-[10px]">
        Click to go to definition · Shift-click for usages ·{' '}
        {getNavigateBackShortcutLabel()} to go back
      </div>
    </div>
  );
}
