import type { HTMLAttributes, ReactNode } from 'react';

// A count pill tinted with the surrounding text color, so it follows the
// active theme in any state (the sidebar's Comments tab badge, the panel
// titles below). `currentColor` resolves to whatever foreground the pill
// inherits. Other span attributes (aria-hidden) pass through.
export function CountChip(props: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...props}
      className="inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[color-mix(in_srgb,currentColor_18%,transparent)] px-1 text-[10px] leading-none font-medium tabular-nums"
    />
  );
}

// The title row every sidebar tab starts with: the tab's name, an optional
// count, and the tab's own controls at the right. A fixed height, so each
// tab's content starts at the same place and switching tabs doesn't make it
// jump. Touch screens get 40px, room for a segmented control's 32px
// segments on its inset track.
export function SidebarPanelHeader({
  children,
  count,
  title,
}: {
  children?: ReactNode;
  count?: number;
  title: string;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 px-3 pointer-coarse:h-10">
      <h2 className="text-foreground flex min-w-0 items-center gap-1.5 text-[13px] font-semibold">
        <span className="truncate">{title}</span>
        {count != null && count > 0 && <CountChip>{count}</CountChip>}
      </h2>
      {children != null && (
        <div className="ml-auto flex min-w-0 items-center gap-1">
          {children}
        </div>
      )}
    </div>
  );
}
