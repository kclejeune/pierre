'use client';

import { IconBrandGithub } from '@pierre/icons';
import Link from 'next/link';

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
export function AppNavbar({ className, tokenState }: AppNavbarProps) {
  const ownTokenState = useGitHubToken();
  const { clearToken, hasToken, setToken } = tokenState ?? ownTokenState;
  const githubUser = useGitHubUser();
  return (
    <nav
      aria-label="Site"
      className={cn('flex items-center justify-end gap-2 px-4 py-3', className)}
    >
      <CommandPaletteTrigger className="w-40 min-w-0 min-[420px]:w-64 sm:w-80" />
      <Link
        href="/pulls"
        className="bg-background hover:bg-accent inline-flex h-9 items-center rounded-md border px-3.5 text-sm font-medium shadow-xs transition-colors"
      >
        Pulls
      </Link>
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
              <CommentAuthorAvatar author={githubUser} className="size-5" />
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
    </nav>
  );
}
