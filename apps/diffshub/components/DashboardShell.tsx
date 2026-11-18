'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { AppNavbar } from './AppNavbar';
import { DiffsHubLogo } from './DiffsHubLogo';
import type { GitHubTokenState } from './useGitHubToken';
import { cn } from '@/lib/cn';

export const SECTION_CARD_CLASS =
  'bg-background overflow-hidden rounded-lg border';

// Content column caps. `full` suits /pulls, whose filter rail, list, and
// preview pane share the row; `wide` suits a single wide list; `medium` suits
// pages whose widest content is two short lists side by side (/browse). All
// stay fluid below their cap.
const WIDTH_CLASSES = {
  full: 'max-w-[160rem]',
  medium: 'max-w-5xl',
  wide: 'max-w-[88rem]',
} as const;

// The chrome shared by the /pulls and /browse dashboards: navbar, centered
// content column, and the "DiffsHub / <section>" title. From md up the title
// sits in the navbar's otherwise empty left side, so the content starts
// right under the navbar; on phones, where the navbar's controls fill the
// row, it keeps its own line. `fillViewport`
// pins the page to the viewport height instead of letting it scroll: the
// content column becomes a flex column whose children (given `min-h-0
// flex-1`) take the height left under the header and scroll internally, as
// the /pulls list and preview pane do on desktop.
export function DashboardShell({
  children,
  fillViewport = false,
  section,
  tokenState,
  width = 'wide',
}: {
  children: ReactNode;
  fillViewport?: boolean;
  section: string;
  tokenState: GitHubTokenState;
  width?: keyof typeof WIDTH_CLASSES;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center md:bg-[var(--diffshub-sidebar-bg)]',
        fillViewport ? 'h-[100svh] overflow-hidden' : 'min-h-[100svh]'
      )}
    >
      <AppNavbar
        className="w-full shrink-0"
        contentClassName={cn('md:px-5 lg:px-8', WIDTH_CLASSES[width])}
        leading={<SectionTitle className="max-md:hidden" section={section} />}
        tokenState={tokenState}
      />
      <div
        className={cn(
          'w-full space-y-6 px-5 pt-2 pb-8 md:space-y-0 md:pt-1 md:pb-12 lg:px-8',
          fillViewport && 'flex min-h-0 flex-1 flex-col md:pb-6',
          WIDTH_CLASSES[width]
        )}
      >
        <SectionTitle className="text-2xl md:hidden" section={section} />
        {children}
      </div>
    </div>
  );
}

// "DiffsHub / <section>", linking home. Sized by the caller: navbar-sized by
// default, 2xl on its own line on phones.
function SectionTitle({
  className,
  section,
}: {
  className?: string;
  section: string;
}) {
  return (
    <header
      className={cn(
        'flex shrink-0 items-center gap-1.5 text-base font-semibold tracking-tight',
        className
      )}
    >
      <Link href="/" className="flex items-center gap-1.5">
        <DiffsHubLogo />
        DiffsHub
      </Link>
      <span className="text-muted-foreground">/ {section}</span>
    </header>
  );
}
