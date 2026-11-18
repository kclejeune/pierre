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
  full: 'max-w-[120rem]',
  medium: 'max-w-5xl',
  wide: 'max-w-[88rem]',
} as const;

// The chrome shared by the /pulls and /browse dashboards: navbar, centered
// content column, and the "DiffsHub / <section>" header.
export function DashboardShell({
  children,
  section,
  tokenState,
  width = 'wide',
}: {
  children: ReactNode;
  section: string;
  tokenState: GitHubTokenState;
  width?: keyof typeof WIDTH_CLASSES;
}) {
  return (
    <div className="flex min-h-[100svh] flex-col items-center md:bg-[var(--diffshub-sidebar-bg)]">
      <AppNavbar className="w-full" tokenState={tokenState} />
      <div
        className={cn(
          'w-full space-y-6 px-5 pt-2 pb-8 md:pt-4 md:pb-12 lg:px-8',
          WIDTH_CLASSES[width]
        )}
      >
        <header className="flex items-center gap-1.5">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-2xl font-semibold tracking-tight"
          >
            <DiffsHubLogo />
            DiffsHub
          </Link>
          <span className="text-muted-foreground text-2xl font-semibold tracking-tight">
            / {section}
          </span>
        </header>
        {children}
      </div>
    </div>
  );
}
