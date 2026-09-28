'use client';

import Link from 'next/link';
import { type ReactNode, useEffect, useRef, useState } from 'react';

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

// Call `requestReveal()` with a pick; the section at `ref` scrolls into view
// once that render commits.
export function useRevealDashboardSection<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [requests, setRequests] = useState(0);
  useEffect(() => {
    if (requests > 0) {
      revealDashboardSection(ref.current);
    }
  }, [requests]);
  return { ref, requestReveal: () => setRequests((count) => count + 1) };
}

// Scrolls a just-opened section into view and focuses it (needs tabIndex={-1}).
// Skips smooth scrolling under reduced motion.
export function revealDashboardSection(element: HTMLElement | null): void {
  if (element == null) {
    return;
  }
  const reduceMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)'
  ).matches;
  element.scrollIntoView({
    behavior: reduceMotion ? 'auto' : 'smooth',
    block: 'start',
  });
  element.focus({ preventScroll: true });
}
