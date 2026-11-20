import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';

import { annotationBorderColor } from '@/lib/annotation';
import { cn } from '@/lib/cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 disabled:shadow-none [&_svg]:pointer-events-none flex-shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive cursor-pointer select-none',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        success:
          'bg-teal-500 text-white hover:bg-teal-500/90 focus-visible:ring-teal-500/20 dark:focus-visible:ring-green-500/40 dark:bg-green-500/60',
        destructive:
          'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60',
        outline:
          'border bg-background hover:bg-secondary hover:text-accent-foreground dark:hover:bg-input/50 dark:border-neutral-800 shadow-xs',
        // Outline buttons on comment surfaces (composers, threads). `outline`
        // fills with the page palette, which is white in the diff but the
        // theme surface in the sidebar; this stays transparent over whichever
        // surface holds it and uses the annotation border, so it looks the
        // same in both.
        annotationOutline: `border ${annotationBorderColor} bg-transparent text-[var(--diffshub-annotation-fg,var(--color-foreground))] hover:bg-[color-mix(in_srgb,currentColor_8%,transparent)]`,
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        tertiary: 'bg-neutral-900/10 shadow-none',
        muted:
          'bg-secondary text-accent-foreground/75 hover:text-accent-foreground',
        ghost:
          'border bg-transparent border-transparent hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        xs: 'h-5.5 rounded-sm gap-1.5 px-1.5 text-xs',
        // List toolbars and the batch bar: 28px, grown to 36px on touch
        // screens so every control on those bars takes a thumb.
        toolbar: 'h-7 rounded-md gap-1 px-1.5 text-xs pointer-coarse:h-9',
        default: 'h-9 px-3.5 py-2 rounded-lg',
        sm: 'h-8 rounded-md gap-1.5 px-3',
        lg: 'h-10 rounded-md px-6',
        xl: 'h-11 rounded-md px-7',
        icon: 'size-9',
        'icon-md': 'size-8 rounded-md',
        'icon-sm': 'size-5 rounded-sm',
        'icon-only': 'size-4 rounded-0 p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export type ButtonProps = React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    // Why the action is unavailable (e.g. a missing GitHub App permission).
    // Set, the button looks disabled, shows the reason as its tooltip, and
    // ignores clicks, but stays hoverable and focusable via aria-disabled;
    // a real `disabled` would swallow the hover that shows the reason.
    blockedReason?: string | null;
  };

function Button({
  className,
  variant,
  size,
  asChild = false,
  blockedReason,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  const blocked =
    blockedReason == null
      ? {}
      : {
          'aria-disabled': true,
          onClick: undefined,
          title: blockedReason,
        };

  return (
    <Comp
      data-slot="button"
      className={cn(
        buttonVariants({ variant, size, className }),
        blockedReason != null && 'cursor-not-allowed opacity-50'
      )}
      {...props}
      {...blocked}
    />
  );
}

export { Button, buttonVariants };
