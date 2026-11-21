'use client';

import * as React from 'react';

import { Button, type ButtonProps } from './Button';
import { cn } from '@/lib/cn';

// How a group of exclusive (or toggling) choices looks. Every option row in
// the app is one of these, so the same kind of choice looks the same
// everywhere:
// - segmented: options on one bordered track, the picked one raised. For a
//   short, fixed set (a filter, a layout, a color mode).
// - chips: separate chips with no track, for sets that wrap or toggle
//   independently (the pulls involvement filter); a selected chip is
//   raised like a segment.
// - tabs: text only, the picked one in the foreground color. For views a
//   page or panel switches between (pull states, sidebar sections).
export type ButtonGroupVariant = 'chips' | 'segmented' | 'tabs';

// The raised look of a selected segment or chip, shared with chips built
// outside a group (RepoPinStrip's ScopeChip). The fill is the theme's
// segment token (lib/theme/deriveChromeTokens), which stands clear of the
// track on light and dark themes alike, where the page background sank
// into it on dark themes.
export const SELECTED_SEGMENT_CLASS =
  'text-foreground border-[var(--diffshub-popover-border,var(--color-border))] bg-[var(--diffshub-segment-selected-bg,var(--color-background))] font-medium shadow-xs hover:bg-[var(--diffshub-segment-selected-bg,var(--color-background))] dark:hover:bg-[var(--diffshub-segment-selected-bg,var(--color-background))]';

// An unselected chip: no fill or border until hovered, so a row of chips
// reads as one control with its pick raised.
export const UNSELECTED_CHIP_CLASS =
  'text-muted-foreground hover:text-foreground hover:bg-accent/50 dark:hover:bg-accent/50 border-transparent';

interface ButtonGroupContextValue {
  selectedValue?: string;
  onValueChange?: (value: string) => void;
  variant: ButtonGroupVariant;
  size?: ButtonProps['size'];
}

const ButtonGroupContext = React.createContext<ButtonGroupContextValue>({
  variant: 'segmented',
});

interface ButtonGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: string;
  onValueChange?: (value: string) => void;
  variant?: ButtonGroupVariant;
  size?: ButtonProps['size'];
  children: React.ReactNode;
}

const TRACK_CLASS: Record<ButtonGroupVariant, string> = {
  chips: 'gap-1',
  segmented: 'bg-secondary gap-0.5 rounded-lg border p-0.5',
  tabs: '',
};

const ITEM_SIZE: Record<ButtonGroupVariant, ButtonProps['size']> = {
  chips: 'segment',
  segmented: 'segment',
  tabs: 'toolbar',
};

// A group of options. With `value`, it is a single-select radio group:
// arrow keys move the pick (as a radio group's do), and only the picked
// option is a Tab stop. Items with their own `selected` toggle
// independently instead and announce as pressed buttons.
function ButtonGroup({
  className,
  value,
  onValueChange,
  variant = 'segmented',
  size,
  children,
  onKeyDown,
  ...props
}: ButtonGroupProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  // A value no option matches leaves every radio out of the Tab order;
  // the first one then takes it, as a radio group with no pick does.
  React.useLayoutEffect(() => {
    const radios = ownRadios(ref.current);
    if (radios.length > 0 && !radios.some((radio) => radio.tabIndex === 0)) {
      radios[0].tabIndex = 0;
    }
  });
  return (
    <ButtonGroupContext.Provider
      value={{ selectedValue: value, onValueChange, variant, size }}
    >
      <div
        ref={ref}
        role={value == null ? 'group' : 'radiogroup'}
        className={cn(
          'inline-flex items-center self-start',
          TRACK_CLASS[variant],
          className
        )}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (!event.defaultPrevented) {
            moveRadioPick(event, ref.current);
          }
        }}
        {...props}
      >
        {children}
      </div>
    </ButtonGroupContext.Provider>
  );
}

// The group's own enabled radios, in order (not a nested group's). Items
// another component gives its own role (a menu's radio items) aren't
// radios here, so the menu keeps its arrow keys.
function ownRadios(group: HTMLElement | null): HTMLButtonElement[] {
  if (group == null) {
    return [];
  }
  return [
    ...group.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
  ].filter(
    (radio) => !radio.disabled && radio.closest('[role="radiogroup"]') === group
  );
}

const NEXT_KEYS = new Set(['ArrowDown', 'ArrowRight']);
const PREVIOUS_KEYS = new Set(['ArrowLeft', 'ArrowUp']);

// Arrow keys (and Home/End) on a radio pick the next option and focus it,
// wrapping at the ends, as the ARIA radio group pattern does.
function moveRadioPick(
  event: React.KeyboardEvent<HTMLDivElement>,
  group: HTMLElement | null
) {
  // A chord (Alt+Left for jump-history back, and the like) is someone
  // else's shortcut.
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return;
  }
  const radios = ownRadios(group);
  const index = radios.indexOf(event.target as HTMLButtonElement);
  if (index === -1) {
    return;
  }
  const next = NEXT_KEYS.has(event.key)
    ? (index + 1) % radios.length
    : PREVIOUS_KEYS.has(event.key)
      ? (index - 1 + radios.length) % radios.length
      : event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? radios.length - 1
          : null;
  if (next == null) {
    return;
  }
  event.preventDefault();
  radios[next].focus();
  radios[next].click();
}

interface ButtonGroupItemProps extends Omit<ButtonProps, 'variant'> {
  value: string;
  // Overrides the group's single-select value, for multi-select groups whose
  // items toggle independently. Set, it also keeps selected items clickable
  // so they can be toggled off.
  selected?: boolean;
  // A tally after the label (matching comments, matching pulls), muted so
  // the label leads. Any node, so a spinner can stand in while it loads.
  count?: React.ReactNode;
  children: React.ReactNode;
}

function ButtonGroupItem({
  className,
  value,
  selected,
  count,
  children,
  onClick,
  ...props
}: ButtonGroupItemProps) {
  const context = React.useContext(ButtonGroupContext);
  const isSelected = selected ?? context.selectedValue === value;
  const isRadio = selected == null;

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (isRadio && isSelected) {
      return;
    }
    context.onValueChange?.(value);
    onClick?.(event);
  };

  // Unselected segments and chips dim, since many themes' muted text
  // matches their body text.
  const { variant } = context;
  return (
    <Button
      // A component that wraps the item (a menu radio item via asChild)
      // passes its own role and state, which win over these.
      {...(isRadio
        ? {
            'aria-checked': isSelected,
            role: 'radio',
            tabIndex: isSelected ? 0 : -1,
          }
        : { 'aria-pressed': isSelected })}
      className={cn(
        variant === 'tabs'
          ? cn(
              'shadow-none hover:bg-transparent dark:hover:bg-transparent',
              isSelected
                ? 'text-foreground hover:text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground font-normal'
            )
          : cn(
              variant === 'segmented' && 'rounded-[calc(var(--radius-lg)-3px)]',
              isSelected
                ? SELECTED_SEGMENT_CLASS
                : variant === 'chips'
                  ? UNSELECTED_CHIP_CLASS
                  : 'text-muted-foreground opacity-70 hover:opacity-100'
            ),
        className
      )}
      variant="ghost"
      size={context.size ?? ITEM_SIZE[variant]}
      onClick={handleClick}
      {...props}
    >
      {children}
      {count != null && (
        <span className="text-muted-foreground font-normal tabular-nums">
          {count}
        </span>
      )}
    </Button>
  );
}

export { ButtonGroup, ButtonGroupItem };
