import type { ReactNode } from 'react';

import { LabelColorDot } from './LabelColorDot';
import type { PullLabel } from '@/lib/pullInfoClient';

// A titled block of the pull details panel. `action` sits at the heading's
// right edge (GitHub's sidebar puts each section's edit control there). The
// heading row is as tall as an xs button, so an Edit control arriving once
// permissions load doesn't push the section down. `inline` puts a one-line
// section (an empty one's Add button or note) beside its heading instead of
// under it, so empty labels and reviewers share a row rather than pushing
// the description down; the panel's sidebar wraps inline sections side by
// side (PANEL_SIDEBAR_CLASS).
export function PanelSection({
  action,
  children,
  heading,
  inline = false,
}: {
  action?: ReactNode;
  children: ReactNode;
  heading: string;
  inline?: boolean;
}) {
  const title = (
    <h4 className="text-muted-foreground text-xs font-medium">{heading}</h4>
  );
  if (inline) {
    return (
      <section className="flex min-h-5.5 items-center gap-2">
        {title}
        {children}
      </section>
    );
  }
  return (
    <section className="flex w-full flex-col gap-1.5">
      <div className="flex min-h-5.5 items-center justify-between gap-2">
        {title}
        {action}
      </div>
      {children}
    </section>
  );
}

// The line an empty section shows (a "None yet" note, a loading note, or an
// Add button), sized to the xs button so switching between them as data
// loads keeps the section's height.
export function PanelSectionSlot({ children }: { children: ReactNode }) {
  return <div className="flex min-h-5.5 items-center">{children}</div>;
}

// A label as the panel shows it: color dot and name, plus `children` (the
// remove button when editable). Shared with the preview's loading skeleton
// so the two match.
export function LabelChip({
  children,
  label,
}: {
  children?: ReactNode;
  label: PullLabel;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-4 font-medium">
      <LabelColorDot color={label.color} />
      {label.name}
      {children}
    </span>
  );
}

// The panel's body grid: past 48rem (the wide /pulls preview) labels and
// reviewers move into a sidebar beside the description, as on GitHub's PR
// page. Shared with the preview's loading skeleton so the two match.
export const PANEL_GRID_CLASS =
  '@3xl:grid @3xl:grid-cols-[minmax(0,1fr)_17rem] @3xl:items-start @3xl:gap-x-6';
export const PANEL_SIDEBAR_CLASS =
  'flex min-w-0 flex-wrap items-start gap-x-6 gap-y-3 @3xl:col-start-2 @3xl:row-start-1';
export const PANEL_MAIN_CLASS = 'min-w-0 @3xl:col-start-1 @3xl:row-start-1';
