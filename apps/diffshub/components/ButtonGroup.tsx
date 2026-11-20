'use client';

import * as React from 'react';

import { Button, type ButtonProps } from './Button';
import { cn } from '@/lib/cn';

interface ButtonGroupContextValue {
  selectedValue?: string;
  onValueChange?: (value: string) => void;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
}

const ButtonGroupContext = React.createContext<ButtonGroupContextValue>({});

interface ButtonGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: string;
  onValueChange?: (value: string) => void;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  children: React.ReactNode;
}

function ButtonGroup({
  className,
  value,
  onValueChange,
  variant = 'outline',
  size,
  children,
  ...props
}: ButtonGroupProps) {
  return (
    <ButtonGroupContext.Provider
      value={{
        selectedValue: value,
        onValueChange,
        variant,
        size,
      }}
    >
      <div
        className={cn(
          'bg-secondary inline-flex self-start rounded-lg',
          className
        )}
        role="group"
        {...props}
      >
        {children}
      </div>
    </ButtonGroupContext.Provider>
  );
}

interface ButtonGroupItemProps extends Omit<ButtonProps, 'variant'> {
  value: string;
  // Overrides the group's single-select value, for multi-select groups whose
  // items toggle independently. Set, it also keeps selected items clickable
  // so they can be toggled off.
  selected?: boolean;
  children: React.ReactNode;
}

function ButtonGroupItem({
  className,
  value,
  selected,
  children,
  onClick,
  ...props
}: ButtonGroupItemProps) {
  const context = React.useContext(ButtonGroupContext);
  const isSelected = selected ?? context.selectedValue === value;

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    context.onValueChange?.(value);
    onClick?.(event);
  };

  // A segmented group (the default outline variant) paints its selected
  // segment with the theme's segment token (lib/theme/deriveChromeTokens),
  // which stands clear of the track on light and dark themes alike, over
  // the borderless ghost button rather than the outline variant, whose page
  // background fill sank into the track on dark themes. Unselected labels
  // dim, since many themes' muted text matches their body text.
  const variant = context.variant ?? 'outline';
  const segmented = variant === 'outline';
  return (
    <Button
      className={cn(
        'text-muted-foreground rounded-[calc(var(--radius-lg)-1px)] gap-1.5',
        isSelected
          ? cn(
              'text-foreground shadow-xs',
              segmented &&
                'border-[var(--diffshub-popover-border,var(--color-border))] bg-[var(--diffshub-segment-selected-bg,var(--color-background))] font-medium hover:bg-[var(--diffshub-segment-selected-bg,var(--color-background))] dark:hover:bg-[var(--diffshub-segment-selected-bg,var(--color-background))]'
            )
          : segmented && 'opacity-70 hover:opacity-100',
        isSelected && selected == null && 'pointer-events-none',
        className
      )}
      variant={isSelected && !segmented ? variant : 'ghost'}
      size={context.size}
      onClick={handleClick}
      title={value}
      {...props}
    >
      {children}
    </Button>
  );
}

export { ButtonGroup, ButtonGroupItem };
