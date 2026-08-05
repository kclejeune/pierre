'use client';

import { useState } from 'react';

import { GitHubAssetImage } from './GitHubAssetImage';
import { useGitHubEnvironment } from './GitHubEnvironmentProvider';
import { cn } from '@/lib/cn';
import { createGitHubWebAssetProxyURL } from '@/lib/githubWebAssets';
import type { CommentAuthor } from '@/lib/types';

interface CommentAuthorAvatarProps {
  author: CommentAuthor;
  className?: string;
}

// Renders a circular avatar image for a comment author. Avatars served by the
// GitHub instance itself go through the authenticated web-asset proxy (on
// private-mode GHES they are behind auth the browser cannot attach
// cross-origin); when the image still fails to load, the author's initial
// renders instead of a broken-image glyph.
// Defaults to 32px (size-8); pass className to override for other sizes.
export function CommentAuthorAvatar({
  author,
  className,
}: CommentAuthorAvatarProps) {
  const { webURL } = useGitHubEnvironment();
  const [failed, setFailed] = useState(false);
  const proxied = createGitHubWebAssetProxyURL(author.avatarUrl, webURL);

  if (failed || author.avatarUrl === '') {
    return (
      <div
        aria-label={author.login}
        className={cn(
          'bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center self-start rounded-full border border-[rgb(0_0_0_/_0.1)] text-[12px] font-semibold uppercase select-none dark:border-[rgb(255_255_255_/_0.1)]',
          className
        )}
      >
        {author.login.slice(0, 1)}
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
