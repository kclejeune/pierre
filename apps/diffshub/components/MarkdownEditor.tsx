'use client';

import {
  IconAt,
  IconCheck,
  IconChevronSm,
  IconCode,
  IconCommentSuggest,
  IconLink,
  IconListCheck,
  IconListOrdered,
  IconListUnordered,
  IconQuoteBlock,
  IconTextBold,
  IconTextItalics,
} from '@pierre/icons';
import {
  type ClipboardEvent,
  type ComponentType,
  type KeyboardEvent,
  type RefObject,
  useId,
  useRef,
  useState,
} from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './DropdownMenu';
import { MarkdownContent } from './MarkdownContent';
import { formatShortcut, useModifierKey } from './ShortcutHint';
import { useDropdownChromeStyle } from './useDropdownChromeStyle';
import { annotationBorderColor } from '@/lib/annotation';
import { cn } from '@/lib/cn';
import {
  editMarkdown,
  HEADING_FORMATS,
  HEADING_PREFIXES,
  headingFormatAt,
  isPastedURL,
  linkSelectionTo,
  type MarkdownAction,
  type MarkdownEdit,
  type MarkdownFormat,
  type MarkdownHeadingFormat,
} from '@/lib/markdownEditing';

const FORMAT_SHORTCUTS: Record<string, MarkdownFormat> = {
  b: 'bold',
  e: 'code',
  i: 'italic',
  k: 'link',
};

// Cmd/Ctrl+Enter, plus Shift+Enter, which the inline composers always accepted.
function isSubmitChord(event: KeyboardEvent): boolean {
  return (
    event.key === 'Enter' && (event.metaKey || event.ctrlKey || event.shiftKey)
  );
}

// Edits through execCommand so they join the undo stack and fire input events.
// The setRangeText fallback skips undo. Exported for composer buttons that
// insert text at the cursor (e.g. "Suggest change").
export function applyEdit(
  textarea: HTMLTextAreaElement,
  edit: MarkdownEdit
): void {
  const start = textarea.selectionStart;
  textarea.focus();
  const inserted =
    typeof document.execCommand === 'function' &&
    document.execCommand('insertText', false, edit.replacement);
  if (!inserted) {
    textarea.setRangeText(edit.replacement);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }
  textarea.setSelectionRange(
    start + edit.selectionStart,
    start + edit.selectionEnd
  );
}

interface ToolbarButton {
  action: MarkdownAction;
  Icon: ComponentType<{ className?: string }>;
  label: string;
  // The Cmd/Ctrl shortcut key, shown in the tooltip.
  shortcutKey?: string;
}

// GitHub's toolbar groups, in its order; the first group also starts with
// the heading menu (see HeadingMenu). Container queries decide where the
// toolbar sits and which groups show; see TOOLBAR_GROUP_VISIBILITY.
const TOOLBAR_GROUPS: readonly (readonly ToolbarButton[])[] = [
  [
    {
      action: 'bold',
      Icon: IconTextBold,
      label: 'Bold',
      shortcutKey: 'B',
    },
    {
      action: 'italic',
      Icon: IconTextItalics,
      label: 'Italic',
      shortcutKey: 'I',
    },
    {
      action: 'quote',
      Icon: IconQuoteBlock,
      label: 'Quote',
    },
    {
      action: 'code',
      Icon: IconCode,
      label: 'Code',
      shortcutKey: 'E',
    },
    {
      action: 'link',
      Icon: IconLink,
      label: 'Link',
      shortcutKey: 'K',
    },
  ],
  [
    {
      action: 'ordered-list',
      Icon: IconListOrdered,
      label: 'Numbered list',
    },
    {
      action: 'unordered-list',
      Icon: IconListUnordered,
      label: 'Unordered list',
    },
    {
      action: 'task-list',
      Icon: IconListCheck,
      label: 'Task list',
    },
  ],
  [{ action: 'mention', Icon: IconAt, label: 'Mention' }],
];

// Which container widths show each toolbar group. Below 21rem (the PR
// sidebar, small phones) the toolbar takes its own row above the tabs, where
// every group fits down to about 15rem; from 21rem it shares the tab row and
// the later groups wait until there is room beside the tabs.
const TOOLBAR_GROUP_VISIBILITY = [
  'flex',
  'hidden @[15rem]:flex @[21rem]:hidden @[27rem]:flex',
  'hidden @[17rem]:flex @[21rem]:hidden @[31rem]:flex',
];

// Shared look of every toolbar control: muted icon, hover wash on the
// annotation surface, focus ring.
const TOOLBAR_BUTTON_BASE =
  'text-muted-foreground hover:text-foreground focus-visible:ring-ring flex items-center justify-center rounded-md outline-none hover:bg-[color-mix(in_srgb,currentColor_10%,transparent)] focus-visible:ring-2 disabled:opacity-50';

// Toolbar controls shrink a step on the narrow toolbar row so all groups
// fit. Square icon buttons take both; the heading trigger, wider for its
// chevron, takes only the height.
const TOOLBAR_BUTTON_HEIGHT = 'h-6 @[21rem]:h-7';
const TOOLBAR_BUTTON_SIZE = `${TOOLBAR_BUTTON_HEIGHT} w-6 @[21rem]:w-7`;

// Each heading menu item previews its level's relative size.
const HEADING_PREVIEW_SIZES: Record<MarkdownHeadingFormat, string> = {
  'heading-1': 'text-[17px]',
  'heading-2': 'text-[15px]',
  'heading-3': 'text-[13px]',
};

// Marks overlays that belong to an editor (the heading menu) so composers
// that close on outside clicks can tell them apart from the rest of the
// page: the menu renders in a portal, outside the composer's own DOM.
const COMPOSER_OVERLAY_ATTRIBUTE = 'data-composer-overlay';

export function isComposerOverlayEvent(event: Event): boolean {
  return event
    .composedPath()
    .some(
      (node) =>
        node instanceof Element && node.hasAttribute(COMPOSER_OVERLAY_ATTRIBUTE)
    );
}

// Runs a toolbar action or formatting shortcut against the textarea's
// current selection, selecting the range it rewrites first so the edit lands
// on the undo stack as one step.
function applyMarkdownAction(
  textarea: HTMLTextAreaElement,
  action: MarkdownAction
): void {
  const { edit, end, start } = editMarkdown(
    textarea.value,
    textarea.selectionStart,
    textarea.selectionEnd,
    action
  );
  textarea.focus();
  textarea.setSelectionRange(start, end);
  applyEdit(textarea, edit);
}

interface MarkdownEditorProps {
  autoFocus?: boolean;
  'aria-label'?: string;
  disabled?: boolean;
  textareaClassName?: string;
  placeholder?: string;
  rows?: number;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onCancel?(): void;
  onChange(value: string): void;
  // Keydowns the editor doesn't handle, e.g. to block Radix typeahead.
  onKeyDown?(event: KeyboardEvent<HTMLTextAreaElement>): void;
  // Shows the toolbar's "Suggest change" button (line comments on a pull's
  // head side); the caller inserts the suggestion fence.
  onSuggestChange?(): void;
  onSubmit?(): void;
}

// The shared markdown field, laid out like GitHub's comment box: Write and
// Preview tabs beside a formatting toolbar, an inset textarea, and a
// "Markdown is supported" footer. Keyboard: GitHub's formatting shortcuts
// (Cmd/Ctrl+B/I/E/K; paste a URL over a selection to link it), the submit
// chord, and Escape to cancel.
export function MarkdownEditor({
  'aria-label': ariaLabel,
  autoFocus = false,
  disabled = false,
  onCancel,
  onChange,
  onKeyDown,
  onSubmit,
  onSuggestChange,
  placeholder,
  rows = 4,
  textareaClassName,
  textareaRef: externalTextareaRef,
  value,
}: MarkdownEditorProps) {
  const [previewing, setPreviewing] = useState(false);
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalTextareaRef ?? internalTextareaRef;
  const tabsId = useId();
  const modifier = useModifierKey();

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape' && onCancel != null) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (isSubmitChord(event) && onSubmit != null) {
      event.preventDefault();
      onSubmit();
      return;
    }
    const format =
      (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
        ? FORMAT_SHORTCUTS[event.key.toLowerCase()]
        : undefined;
    if (format != null) {
      event.preventDefault();
      applyMarkdownAction(event.currentTarget, format);
      return;
    }
    onKeyDown?.(event);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const textarea = event.currentTarget;
    const pasted = event.clipboardData.getData('text/plain').trim();
    const selected = textarea.value.slice(
      textarea.selectionStart,
      textarea.selectionEnd
    );
    if (selected === '' || selected.includes('\n') || !isPastedURL(pasted)) {
      return;
    }
    event.preventDefault();
    applyEdit(textarea, linkSelectionTo(selected, pasted));
  }

  function selectTab(nextPreviewing: boolean) {
    setPreviewing(nextPreviewing);
    if (!nextPreviewing) {
      requestAnimationFrame(() =>
        textareaRef.current?.focus({ preventScroll: true })
      );
    }
  }

  // Toolbar buttons are disabled with the editor, so only a missing textarea
  // (preview tab) needs guarding.
  function withTextarea(action: (textarea: HTMLTextAreaElement) => void) {
    const textarea = textareaRef.current;
    if (textarea != null) {
      action(textarea);
    }
  }

  return (
    <div
      className={cn(
        '@container flex w-full min-w-0 flex-col rounded-md border bg-[var(--diffshub-annotation-bg,var(--color-card))]',
        annotationBorderColor
      )}
    >
      <div
        className={cn(
          'flex min-w-0 flex-wrap items-end gap-x-2 rounded-t-md border-b bg-[color-mix(in_srgb,currentColor_4%,transparent)] pr-1.5',
          annotationBorderColor
        )}
      >
        <div
          role="tablist"
          aria-label="Comment editor mode"
          className="-mb-px flex shrink-0 pt-1.5 pl-1.5"
        >
          {(
            [
              ['Write', false],
              ['Preview', true],
            ] as const
          ).map(([label, isPreviewTab]) => {
            const selected = previewing === isPreviewTab;
            return (
              <button
                key={label}
                type="button"
                role="tab"
                id={`${tabsId}-${label}`}
                aria-controls={`${tabsId}-panel`}
                aria-selected={selected}
                disabled={disabled}
                className={cn(
                  'focus-visible:ring-ring rounded-t-md border border-b-0 px-3 py-1.5 text-[13px] outline-none focus-visible:ring-2 disabled:opacity-50',
                  selected
                    ? cn(
                        annotationBorderColor,
                        'bg-[var(--diffshub-annotation-bg,var(--color-card))] font-medium text-[var(--diffshub-annotation-fg,var(--color-foreground))]'
                      )
                    : 'text-muted-foreground hover:text-foreground border-transparent'
                )}
                onClick={() => selectTab(isPreviewTab)}
              >
                {label}
              </button>
            );
          })}
        </div>
        {!previewing && (
          <div
            role="toolbar"
            aria-label="Formatting"
            className="ml-auto flex min-w-0 items-center self-center py-1 @max-[21rem]:order-first @max-[21rem]:basis-full @max-[21rem]:justify-start @max-[21rem]:pt-1.5 @max-[21rem]:pb-0 @max-[21rem]:pl-1"
          >
            {onSuggestChange != null && (
              <span className="flex items-center">
                <ToolbarIconButton
                  disabled={disabled}
                  Icon={IconCommentSuggest}
                  label="Suggest change"
                  onActivate={() => withTextarea(onSuggestChange)}
                />
                <ToolbarDivider />
              </span>
            )}
            {TOOLBAR_GROUPS.map((group, groupIndex) => (
              <span
                key={groupIndex}
                className={cn(
                  'items-center',
                  TOOLBAR_GROUP_VISIBILITY[groupIndex]
                )}
              >
                {groupIndex > 0 && <ToolbarDivider />}
                {groupIndex === 0 && (
                  <HeadingMenu
                    disabled={disabled}
                    textareaRef={textareaRef}
                    onPick={(format) =>
                      withTextarea((textarea) =>
                        applyMarkdownAction(textarea, format)
                      )
                    }
                  />
                )}
                {group.map((button) => (
                  <ToolbarIconButton
                    key={button.label}
                    disabled={disabled}
                    Icon={button.Icon}
                    label={
                      button.shortcutKey == null
                        ? button.label
                        : `${button.label} (${formatShortcut(modifier, button.shortcutKey)})`
                    }
                    onActivate={() =>
                      withTextarea((textarea) =>
                        applyMarkdownAction(textarea, button.action)
                      )
                    }
                  />
                ))}
              </span>
            ))}
          </div>
        )}
      </div>
      <div
        className="p-2"
        id={`${tabsId}-panel`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-${previewing ? 'Preview' : 'Write'}`}
      >
        {previewing ? (
          <div className="min-h-[5.5rem] w-full px-1 py-1">
            {value.trim() === '' ? (
              <p className="text-muted-foreground m-0 text-[13px]">
                Nothing to preview
              </p>
            ) : (
              <MarkdownContent flavor="comment" markdown={value} />
            )}
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            aria-label={ariaLabel}
            autoFocus={autoFocus}
            disabled={disabled}
            placeholder={placeholder}
            rows={rows}
            value={value}
            className={cn(
              annotationBorderColor,
              'field-sizing-content block min-h-[5.5rem] w-full resize-y rounded-md border bg-[var(--diffshub-annotation-bg,var(--color-background))] px-3 py-2 text-[14px] text-inherit placeholder:text-[var(--diffshub-popover-muted-fg,var(--color-muted-foreground))] focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none disabled:opacity-60',
              textareaClassName
            )}
            onChange={({ currentTarget }) => onChange(currentTarget.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />
        )}
      </div>
      {/* Narrow editors keep the submit shortcut and let the Markdown mark
          alone say "Markdown"; touch devices, with no shortcut to press,
          keep the words instead. */}
      <div
        className="text-muted-foreground flex min-w-0 items-center gap-1.5 px-3 pb-2 text-[12px]"
        title="Markdown is supported"
      >
        <MarkdownMark className="h-3 w-[1.1rem] shrink-0" />
        <span className="truncate">
          <span
            className={cn(
              onSubmit != null && '@max-[22rem]:pointer-fine:hidden'
            )}
          >
            Markdown is supported
          </span>
          {onSubmit != null && (
            <span className="pointer-coarse:hidden">
              <span className="@max-[22rem]:hidden"> · </span>
              {`${formatShortcut(modifier, '↵')} to submit`}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

function ToolbarIconButton({
  disabled,
  Icon,
  label,
  onActivate,
}: {
  disabled: boolean;
  Icon: ComponentType<{ className?: string }>;
  label: string;
  onActivate(): void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      className={cn(TOOLBAR_BUTTON_BASE, TOOLBAR_BUTTON_SIZE)}
      // Keep focus (and the selection) in the textarea while clicking.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onActivate}
    >
      <Icon className="size-4" />
    </button>
  );
}

// The toolbar's heading control: one "H" button opening Heading 1–3, since a
// single heading button can't say which level it inserts. Each item shows its
// `#` prefix and previews its size; the caret line's current level is checked,
// and picking it again removes the heading (picking another switches level).
function HeadingMenu({
  disabled,
  onPick,
  textareaRef,
}: {
  disabled: boolean;
  onPick(format: MarkdownHeadingFormat): void;
  // Read when the menu opens (to check the caret line's level) and focused
  // when it closes.
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const dropdownThemeStyle = useDropdownChromeStyle();
  const [current, setCurrent] = useState<MarkdownHeadingFormat | null>(null);
  // Set when a click or focus outside the menu dismisses it, so closing
  // leaves focus where the user moved it instead of pulling it back.
  const dismissedOutsideRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        const textarea = textareaRef.current;
        if (open) {
          dismissedOutsideRef.current = false;
        }
        if (open && textarea != null) {
          setCurrent(headingFormatAt(textarea.value, textarea.selectionStart));
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          title="Heading"
          aria-label="Heading"
          disabled={disabled}
          className={cn(
            TOOLBAR_BUTTON_BASE,
            TOOLBAR_BUTTON_HEIGHT,
            'data-[state=open]:text-foreground gap-px px-1 data-[state=open]:bg-[color-mix(in_srgb,currentColor_10%,transparent)]'
          )}
          // Keep focus (and the selection) in the textarea while clicking.
          onMouseDown={(event) => event.preventDefault()}
        >
          <span aria-hidden className="text-[13px] leading-none font-semibold">
            H
          </span>
          <IconChevronSm aria-hidden className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        {...{ [COMPOSER_OVERLAY_ATTRIBUTE]: '' }}
        align="start"
        className="w-44 p-1"
        style={dropdownThemeStyle}
        // The trigger toggles the menu closed; that counts as outside to
        // Radix but should still return focus to the textarea.
        onInteractOutside={(event) => {
          if (
            !(event.target instanceof Node) ||
            triggerRef.current?.contains(event.target) !== true
          ) {
            dismissedOutsideRef.current = true;
          }
        }}
        // After a pick or Escape, return focus to the textarea (not the
        // trigger) so typing continues where the heading landed. An outside
        // dismissal keeps whatever the user clicked or tabbed to.
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (!dismissedOutsideRef.current) {
            textareaRef.current?.focus({ preventScroll: true });
          }
          dismissedOutsideRef.current = false;
        }}
      >
        {HEADING_FORMATS.map((format, index) => (
          <DropdownMenuItem
            key={format}
            className="flex cursor-pointer items-center gap-2"
            onSelect={() => onPick(format)}
          >
            <span
              className={cn(
                'min-w-0 flex-1 truncate font-semibold',
                HEADING_PREVIEW_SIZES[format]
              )}
            >
              Heading {index + 1}
            </span>
            {current === format ? (
              <IconCheck aria-label="Current level" className="size-3.5" />
            ) : (
              <span
                aria-hidden
                className="text-muted-foreground font-mono text-[11px]"
              >
                {HEADING_PREFIXES[format].trim()}
              </span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ToolbarDivider() {
  return (
    <span
      aria-hidden="true"
      className="mx-1 h-4 w-px bg-[var(--diffshub-annotation-border,var(--color-border))]"
    />
  );
}

// The Markdown mark (CC0, by Dustin Curtis), drawn inline since the icon set
// has no equivalent.
function MarkdownMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 208 128"
      fill="currentColor"
      className={className}
    >
      <path d="M193 128H15a15 15 0 0 1-15-15V15A15 15 0 0 1 15 0h178a15 15 0 0 1 15 15v98a15 15 0 0 1-15 15ZM50 98V59l20 25 20-25v39h20V30H90L70 55 50 30H30v68Zm134-34h-20V30h-20v34h-20l30 35Z" />
    </svg>
  );
}
