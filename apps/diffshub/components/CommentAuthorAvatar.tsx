'use client';

import { useState } from 'react';

import { GitHubAssetImage } from './GitHubAssetImage';
import { useGitHubEnvironment } from './GitHubEnvironmentProvider';
import { useGitHubUserName } from './useGitHubUserName';
import { cn } from '@/lib/cn';
import { createGitHubWebAssetProxyURL } from '@/lib/githubWebAssets';
import type { CommentAuthor } from '@/lib/types';

interface CommentAuthorAvatarProps {
  author: CommentAuthor;
  className?: string;
}

// "Kennan LeJeune" → "KL"; a single-word name gives one letter. Comment
// payloads only carry the login, so without a profile name the login's first
// letter is the best available.
function initialsFor(name: string | null, login: string): string {
  const words = name?.trim().split(/\s+/) ?? [];
  if (words.length === 0 || words[0] === '') {
    return login.slice(0, 1).toUpperCase();
  }
  const first = words[0].slice(0, 1);
  const last = words.length > 1 ? (words.at(-1)?.slice(0, 1) ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

// Renders a circular avatar image for a comment author. Avatars served by the
// GitHub instance itself go through the authenticated web-asset proxy (on
// private-mode GHES they are behind auth the browser cannot attach
// cross-origin); when the image still fails to load, the author's initials —
// resolved from their profile's display name — render instead of a
// broken-image glyph.
// Defaults to 32px (size-8); pass className to override for other sizes.
export function CommentAuthorAvatar({
  author,
  className,
}: CommentAuthorAvatarProps) {
  const { webURL } = useGitHubEnvironment();
  const [failed, setFailed] = useState(false);
  const proxied = createGitHubWebAssetProxyURL(author.avatarUrl, webURL);
  const showInitials = failed || author.avatarUrl === '';
  const displayName = useGitHubUserName(showInitials ? author.login : null);

  if (showInitials) {
    return (
      <div
        aria-label={author.login}
        title={displayName ?? author.login}
        className={cn(
          'bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center self-start rounded-full border border-[rgb(0_0_0_/_0.1)] text-[12px] font-semibold select-none dark:border-[rgb(255_255_255_/_0.1)]',
          className
        )}
      >
        {initialsFor(displayName, author.login)}
      </div>
    );
  }

  const imageProps = {
    alt: author.login,
    className: cn('block size-8 rounded-full object-cover', className),
    onError: () => setFailed(true),
  };
  return (
    <div className="relative shrink-0 self-start after:absolute after:inset-0 after:z-10 after:block after:rounded-full after:border after:border-[rgb(0_0_0_/_0.1)] after:content-[''] dark:after:border-[rgb(255_255_255_/_0.1)]">
      {proxied != null ? (
        <GitHubAssetImage {...imageProps} src={proxied} />
      ) : (
        <img {...imageProps} src={author.avatarUrl} />
      )}
    </div>
  );
}
