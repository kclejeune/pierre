'use client';

import { useState } from 'react';

import { GitHubAssetImage } from './GitHubAssetImage';
import { useGitHubEnvironment } from './GitHubEnvironmentProvider';
import { useGitHubUserProfile } from './useGitHubUserProfile';
import { cn } from '@/lib/cn';
import { createGitHubWebAssetProxyURL } from '@/lib/githubWebAssets';
import type { CommentAuthor } from '@/lib/types';

interface CommentAuthorAvatarProps {
  author: CommentAuthor;
  className?: string;
}

// Avatar URLs that already failed to load, kept module-level so a dead URL
// (404, expired signed URL) is not re-requested every time another card for
// the same author mounts under scroll virtualization.
const failedAvatarSrcs = new Set<string>();

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

// Renders a circular avatar image for a comment author. The URL embedded in
// the comment payload is tried first; avatars served by the GitHub instance
// itself go through the authenticated web-asset proxy (on private-mode GHES
// they are behind auth the browser cannot attach cross-origin). When the
// embedded URL is missing or fails to load — payload avatar URLs can be
// short-lived signed URLs on GHES / enterprise managed users — a fresh
// avatar URL is fetched from the author's API profile and tried next; only
// when that fails too do the author's initials (resolved from the same
// profile's display name) render instead of a broken-image glyph.
// Defaults to 32px (size-8) aligned to the top of the row (comment-card
// layout); className lands on the outer element in both branches, so callers
// can override size and alignment (e.g. `size-6 self-center`).
export function CommentAuthorAvatar({
  author,
  className,
}: CommentAuthorAvatarProps) {
  const { webURL } = useGitHubEnvironment();
  // Bumped when a source fails so the component re-renders against the
  // module-level failure set.
  const [, setFailCount] = useState(0);

  const payloadSrc = author.avatarUrl === '' ? null : author.avatarUrl;
  const payloadUsable = payloadSrc != null && !failedAvatarSrcs.has(payloadSrc);
  // The profile also supplies the display name behind initials, so one
  // request serves both fallback stages.
  const profile = useGitHubUserProfile(payloadUsable ? null : author.login);
  const profileSrc =
    profile != null &&
    profile.avatarUrl !== '' &&
    profile.avatarUrl !== payloadSrc
      ? profile.avatarUrl
      : null;
  const src = payloadUsable
    ? payloadSrc
    : profileSrc != null && !failedAvatarSrcs.has(profileSrc)
      ? profileSrc
      : null;

  if (src == null) {
    const displayName = profile?.name ?? null;
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

  const proxied = createGitHubWebAssetProxyURL(src, webURL);
  const imageProps = {
    alt: author.login,
    className: 'block size-full rounded-full object-cover',
    onError: () => {
      failedAvatarSrcs.add(src);
      setFailCount((count) => count + 1);
    },
  };
  return (
    <div
      className={cn(
        "relative size-8 shrink-0 self-start after:absolute after:inset-0 after:z-10 after:block after:rounded-full after:border after:border-[rgb(0_0_0_/_0.1)] after:content-[''] dark:after:border-[rgb(255_255_255_/_0.1)]",
        className
      )}
    >
      {proxied != null ? (
        <GitHubAssetImage {...imageProps} src={proxied} />
      ) : (
        <img {...imageProps} src={src} />
      )}
    </div>
  );
}
