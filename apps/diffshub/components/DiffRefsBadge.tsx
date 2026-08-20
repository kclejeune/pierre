'use client';

import { IconFolder } from '@pierre/icons';
import Link from 'next/link';
import type { CSSProperties } from 'react';

import {
  RefPickerAction,
  RefPickerItems,
  RefPillArrow,
  RefPillMenu,
  useLazyRepoRefs,
} from './RefPicker';
import type { RepoRefsState } from './useRepoRefs';
import { cn } from '@/lib/cn';
import type { DiffRefEnd, DiffRefs } from '@/lib/diffRefs';
import { buildComparePath } from '@/lib/repoBrowser';

interface DiffRefsBadgeProps {
  className?: string;
  dropdownThemeStyle?: CSSProperties;
  refs: DiffRefs;
}

// Header display of what the loaded diff compares: the base ref on the left
// and the head ref on the right — matching the split view (base/old on the
// left, head/new on the right) and GitHub's `base...head` compare grammar —
// with the arrow between them pointing left, the direction the changes flow
// ("merge <head> into <base>"). Each pill is labeled outright so the reading
// never depends on the arrow alone. Clicking a pill opens a ref picker:
// browse the files at that ref, or swap that side of the comparison for
// another branch (which navigates to the matching compare view — on a pull
// request this deliberately leaves the PR for a plain compare and never
// touches the PR's own base). A bare compare (`compare/<ref>`) shows its
// implicit base as a muted "default" pill that picks an explicit base.
export function DiffRefsBadge({
  className,
  dropdownThemeStyle,
  refs,
}: DiffRefsBadgeProps) {
  // One lazy branch listing feeds both pills; either menu's first open
  // triggers the single load.
  const { handleOpenChange, refsState } = useLazyRepoRefs(refs.repo);
  // Refs already occupying a side of the comparison, hidden from both
  // pickers — picking one would build a degenerate or no-op compare.
  const excludeRefs =
    refs.base == null ? [refs.head.label] : [refs.base.label, refs.head.label];
  const description =
    refs.base == null
      ? `Changes on ${refs.head.label} (head) against the default branch`
      : `Changes on ${refs.head.label} (head) into ${refs.base.label} (base)`;
  return (
    <div
      role="group"
      className={cn('flex shrink-0 items-center gap-1 text-xs', className)}
      aria-label={description}
      title={description}
    >
      <RefPill
        kind="base"
        end={refs.base}
        refs={refs}
        refsState={refsState}
        excludeRefs={excludeRefs}
        onOpenChange={handleOpenChange}
        dropdownThemeStyle={dropdownThemeStyle}
      />
      <RefPillArrow />
      <RefPill
        kind="head"
        end={refs.head}
        refs={refs}
        refsState={refsState}
        excludeRefs={excludeRefs}
        onOpenChange={handleOpenChange}
        dropdownThemeStyle={dropdownThemeStyle}
      />
    </div>
  );
}

interface RefPillProps {
  dropdownThemeStyle?: CSSProperties;
  // Null is the implicit base of a bare `compare/<ref>` range, which GitHub
  // compares against the default branch: shown as a muted "default"
  // placeholder, and picking a branch makes the base explicit.
  end: DiffRefEnd | null;
  excludeRefs: readonly string[];
  kind: 'base' | 'head';
  onOpenChange(open: boolean): void;
  refs: DiffRefs;
  refsState: RepoRefsState;
}

function RefPill({
  dropdownThemeStyle,
  end,
  excludeRefs,
  kind,
  onOpenChange,
  refs,
  refsState,
}: RefPillProps) {
  // Picking a branch swaps this pill's side of the comparison and navigates
  // to the resulting compare view; the other side keeps its spelling (fork
  // heads stay `owner:branch`, a bare-compare head keeps its implicit base).
  const getRefHref = (ref: string) =>
    kind === 'base'
      ? buildComparePath(refs.repo, ref, refs.head.label)
      : buildComparePath(refs.repo, refs.base?.label ?? null, ref);
  return (
    <RefPillMenu
      kind={kind}
      label={end?.label ?? 'default'}
      placeholder={end == null}
      ariaLabel={
        end == null
          ? 'base: the default branch — pick another ref to compare against'
          : `${kind}: ${end.label} — browse this ref or pick another to compare`
      }
      title={`Change the ${kind} ref`}
      dropdownThemeStyle={dropdownThemeStyle}
      onOpenChange={onOpenChange}
    >
      {end?.browsePath != null && (
        <RefPickerAction>
          <Link href={end.browsePath}>
            <IconFolder className="size-3" />
            Browse files at this ref
          </Link>
        </RefPickerAction>
      )}
      <RefPickerItems
        heading={`Switch ${kind} to…`}
        refsState={refsState}
        excludeRefs={excludeRefs}
        getRefHref={getRefHref}
      />
    </RefPillMenu>
  );
}
