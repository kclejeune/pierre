'use client';

import { IconArrowRightShort, IconBranch } from '@pierre/icons';
import Link from 'next/link';

import { cn } from '@/lib/cn';
import type { DiffRefEnd, DiffRefs } from '@/lib/diffRefs';

interface DiffRefsBadgeProps {
  className?: string;
  refs: DiffRefs;
}

// Header display of what the loaded diff compares: the base ref on the left,
// the head ref on the right, each labeled outright so the direction never
// has to be inferred from an arrow. Left-to-right matches the split view
// (base/old on the left, head/new on the right) and GitHub's own
// `base...head` compare grammar. Refs that resolve in the file browser link
// there, so "what does this branch look like?" is one click.
export function DiffRefsBadge({ className, refs }: DiffRefsBadgeProps) {
  const description =
    refs.base == null
      ? `Showing changes on ${refs.head.label} (head) against the default branch`
      : `Showing changes on ${refs.head.label} (head) relative to ${refs.base.label} (base)`;
  return (
    <div
      role="group"
      className={cn('flex shrink-0 items-center gap-1 text-xs', className)}
      aria-label={description}
      title={description}
    >
      {refs.base != null && (
        <>
          <RefPill kind="base" end={refs.base} />
          <IconArrowRightShort
            aria-hidden="true"
            className="text-muted-foreground size-3 shrink-0"
          />
        </>
      )}
      <RefPill kind="head" end={refs.head} />
    </div>
  );
}

const PILL_CLASS =
  'inline-flex h-6 min-w-0 max-w-[32ch] items-center gap-1.5 rounded-md border border-[var(--diffshub-card-border,var(--color-border))] bg-[var(--diffshub-card-bg,var(--color-muted))] px-1.5';

function RefPill({ end, kind }: { end: DiffRefEnd; kind: 'base' | 'head' }) {
  const content = (
    <>
      <span
        aria-hidden="true"
        className="text-muted-foreground inline-flex shrink-0 items-center gap-1 text-[10px] font-medium tracking-wide uppercase"
      >
        <IconBranch className="size-3" />
        {kind}
      </span>
      <span className="truncate font-mono text-[11px]">{end.label}</span>
    </>
  );
  if (end.browsePath == null) {
    return (
      <span className={PILL_CLASS} aria-label={`${kind}: ${end.label}`}>
        {content}
      </span>
    );
  }
  return (
    <Link
      href={end.browsePath}
      aria-label={`${kind}: ${end.label} — browse files at this ref`}
      className={cn(
        PILL_CLASS,
        'hover:bg-[var(--diffshub-card-hover-bg,var(--color-muted))] hover:text-foreground focus-visible:ring-ring outline-none focus-visible:ring-2'
      )}
    >
      {content}
    </Link>
  );
}
