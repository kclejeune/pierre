'use client';

import { IconBrandGithub } from '@pierre/icons';
import { type FormEvent, memo, useState } from 'react';

import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import { useGitHubUser } from './useGitHubUser';
import { Button } from '@/components/Button';
import { useGitHubEnvironment } from '@/components/GitHubEnvironmentProvider';
import { Input } from '@/components/Input';
import { cn } from '@/lib/cn';

// pull_requests=write (not read) so review comments and replies can be
// posted from the viewer; contents stays read-only.
const CREATE_TOKEN_PATH =
  '/settings/personal-access-tokens/new?name=DiffsHub%20Repo%20Access&description=Read+private+PRs%2C+expand+hunks%2C+and+post+review+comments&expires_in=90&contents=read&pull_requests=write&issues=read';

const CLASSIC_TOKEN_PATH =
  '/settings/tokens/new?description=DiffsHub%20Private%20Repo%20Read%20Access&scopes=repo&default_expires_at=90';

interface GitHubTokenControlProps {
  active: boolean;
  className?: string;
  onClear(): void;
  onSave(token: string): void;
  title?: string;
}

function TokenLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      className="inline-link"
      href={href}
      target="_blank"
      rel="noreferrer noopener"
    >
      {children}
    </a>
  );
}

export const GitHubTokenControl = memo(function GitHubTokenControl({
  active,
  className,
  onClear,
  onSave,
  title = 'GitHub Token',
}: GitHubTokenControlProps) {
  const { isGitHubDotCom, oauthEnabled, webURL } = useGitHubEnvironment();
  const githubUser = useGitHubUser();
  const [draftToken, setDraftToken] = useState('');
  const canSave = draftToken.trim() !== '';
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave) {
      return;
    }
    onSave(draftToken);
    setDraftToken('');
  };
  // The login route restores the user to the exact diff they were viewing, so
  // the return path is captured at click time rather than render time.
  const handleSignIn = () => {
    const { hash, pathname, search } = window.location;
    const returnTo = `${pathname}${search}${hash}`;
    window.location.assign(
      `/api/auth/github/login?returnTo=${encodeURIComponent(returnTo)}`
    );
  };

  return (
    <section className={cn('px-2 py-1.5', className)} aria-label={title}>
      <div className="flex items-center gap-1.5 text-sm font-medium">
        <IconBrandGithub className="size-4" />
        <span className="min-w-0 flex-1">{title}</span>
        <span
          className={cn(
            'rounded-full border px-1.5 py-0.5 text-[10px] leading-none tracking-wide uppercase',
            active
              ? 'border-green-600 bg-green-500 text-white dark:border-green-500 dark:bg-green-400 dark:text-black'
              : 'text-muted-foreground border-current/20'
          )}
        >
          {active ? 'Active' : 'Optional'}
        </span>
      </div>
      {active ? (
        <>
          {githubUser != null && (
            <div className="mt-2 flex items-center gap-2 text-[13px]">
              <CommentAuthorAvatar
                author={{
                  avatarUrl: githubUser.avatarUrl,
                  login: githubUser.login,
                }}
                className="size-5"
              />
              <span className="min-w-0 truncate font-medium">
                {githubUser.login}
              </span>
            </div>
          )}
          <p className="text-muted-foreground mt-1 max-w-124 text-[13px] text-pretty">
            Using your saved token from localStorage. Clear it to sign in again
            or use a different token.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setDraftToken('');
                onClear();
              }}
            >
              Clear saved token
            </Button>
          </div>
        </>
      ) : (
        <>
          {oauthEnabled && (
            <div className="mt-2">
              <Button type="button" size="sm" onClick={handleSignIn}>
                <IconBrandGithub className="size-4" />
                Sign in with GitHub
              </Button>
            </div>
          )}
          <p className="text-muted-foreground mt-1 max-w-124 text-[13px] text-pretty">
            {oauthEnabled ? 'Or create' : 'Create'}{' '}
            {isGitHubDotCom ? (
              <>
                <TokenLink href={`${webURL}${CREATE_TOKEN_PATH}`}>
                  a fine-grained PAT
                </TokenLink>{' '}
                on GitHub to view private diffs, or{' '}
                <TokenLink href={`${webURL}${CLASSIC_TOKEN_PATH}`}>
                  a classic token
                </TokenLink>{' '}
                with repo scope.
              </>
            ) : (
              <>
                <TokenLink href={`${webURL}${CLASSIC_TOKEN_PATH}`}>
                  a personal access token
                </TokenLink>{' '}
                with repo scope to view private diffs.
              </>
            )}{' '}
            Saved only in localStorage.
          </p>
          <form className="mt-2 flex gap-1.5" onSubmit={handleSubmit}>
            <Input
              className="bg-background flex-1"
              inputSize="sm"
              type="password"
              autoComplete="off"
              data-1p-ignore
              data-lpignore="true"
              placeholder="Paste token"
              value={draftToken}
              onChange={({ currentTarget }) =>
                setDraftToken(currentTarget.value)
              }
            />
            <Button type="submit" size="sm" disabled={!canSave}>
              Save
            </Button>
          </form>
        </>
      )}
    </section>
  );
});
