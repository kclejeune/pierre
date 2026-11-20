'use client';

import { IconBrandGithub } from '@pierre/icons';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { CommandPaletteTrigger } from './CommandPaletteTrigger';
import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import { useGitHubUser } from './useGitHubUser';
import { Button } from '@/components/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/DropdownMenu';
import { GitHubTokenControl } from '@/components/GitHubTokenControl';
import {
  type GitHubTokenState,
  useGitHubToken,
} from '@/components/useGitHubToken';
import { cn } from '@/lib/cn';

interface AppNavbarProps {
  className?: string;
  // Classes for the inner row, so a page can match its content column's
  // width and padding (the dashboards align the brand with their content).
  contentClassName?: string;
  // Rendered at the start of the row, before the right-aligned controls
  // (the dashboards' "DiffsHub / <section>" title). It is a direct flex
  // child, so it takes mr-auto to push the controls right, and hiding it
  // leaves no empty gap.
  leading?: ReactNode;
  // Pages that already own a useGitHubToken instance (e.g. the dashboard)
  // pass it in so sign-in/sign-out through the navbar updates their UI in the
  // same render; standalone pages let the navbar run its own instance.
  tokenState?: GitHubTokenState;
}

// Shared top navbar for the non-viewer pages (home, /pulls): palette search
// trigger, dashboard link, and the GitHub auth panel behind an account
// button. The diff viewer keeps its specialized chrome header
// (DiffsHubHeader) — its URL field edits the current diff in place, which the
// palette trigger can't replace.
export function AppNavbar({
  className,
  contentClassName,
  leading,
  tokenState,
}: AppNavbarProps) {
  const ownTokenState = useGitHubToken();
  const { clearToken, hasToken, setToken } = tokenState ?? ownTokenState;
  const githubUser = useGitHubUser();
  return (
    <nav aria-label="Site" className={className}>
      <div
        className={cn(
          'mx-auto flex w-full items-center justify-end gap-2 px-4 py-3',
          contentClassName
        )}
      >
        {leading}
        {/* Below sm the search fills what the buttons leave, so it starts
            on the page's side gutter instead of wherever its fixed width
            happens to end. */}
        <CommandPaletteTrigger className="min-w-0 flex-1 sm:w-80 sm:flex-none" />
        <Button asChild variant="outline" className="rounded-md">
          <Link href="/pulls">Pulls</Link>
        </Button>
        <Button asChild variant="outline" className="rounded-md">
          <Link href="/browse">Browse</Link>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="GitHub account"
              className="rounded-md"
            >
              {githubUser != null ? (
                <CommentAuthorAvatar
                  author={githubUser}
                  className="size-6 self-center"
                />
              ) : (
                <IconBrandGithub className="size-4" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80 p-2">
            <GitHubTokenControl
              active={hasToken}
              onClear={clearToken}
              onSave={setToken}
              title="GitHub access"
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </nav>
  );
}
