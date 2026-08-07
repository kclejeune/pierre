'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { AppNavbar } from './AppNavbar';
import { DiffsHubLogo } from './DiffsHubLogo';
import type { GitHubTokenState } from './useGitHubToken';

export const SECTION_CARD_CLASS =
  'bg-background overflow-hidden rounded-lg border';

// The chrome shared by the /pulls and /browse dashboards: navbar, centered
// content column, and the "DiffsHub / <section>" header.
export function DashboardShell({
  children,
  section,
  tokenState,
}: {
  children: ReactNode;
  section: string;
  tokenState: GitHubTokenState;
}) {
  return (
    <div className="flex min-h-[100svh] flex-col items-center md:bg-[var(--diffshub-sidebar-bg)]">
      <AppNavbar className="w-full" tokenState={tokenState} />
      <div className="w-3xl max-w-[100vw] space-y-6 px-5 pt-2 pb-8 md:pt-4 md:pb-12">
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
