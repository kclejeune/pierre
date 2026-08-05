import type { CommentAuthor } from '@/lib/types';

export const annotationCardBase =
  'm-2 flex max-w-[600px] gap-2.5 rounded-xl border border-[var(--diffshub-annotation-border,var(--color-border))] bg-[var(--diffshub-annotation-bg,var(--color-card))] bg-clip-padding p-3 font-sans text-[var(--diffshub-annotation-fg,var(--color-card-foreground))] shadow-[var(--diffshub-annotation-shadow,0_2px_4px_rgb(0_0_0_/_0.025),0_4px_8px_rgb(0_0_0_/_0.025))]';

// All available reviewer personas, derived from /public/diffshub-avatars/ filenames.
const AVATAR_NAMES = [
  'alex',
  'amacateus',
  'amadeus',
  'aussie',
  'cedric',
  'chugs',
  'dwayn',
  'ed',
  'fat',
  'ian',
  'jacob2',
  'joe',
  'kris',
  'mdo',
  'murphy',
  'nicolas',
  'pia',
  'toshi',
  'zac',
] as const;

// Triggers browser fetches for all avatar images so they are in the cache
// before the comment form opens. Call once on mount of the top-level UI component.
export function preloadAvatars(): void {
  for (const name of AVATAR_NAMES) {
    const img = new Image();
    img.src = `/diffshub-avatars/${name}.png`;
  }
}

// Picks a random demo persona as the comment author. Used as the fallback
// identity when no GitHub token is saved (or the token cannot resolve /user);
// intended as a useState lazy initializer so each new draft form gets a fresh
// identity on mount.
export function getRandomPersonaAuthor(): CommentAuthor {
  const name = AVATAR_NAMES[Math.floor(Math.random() * AVATAR_NAMES.length)];
  return { avatarUrl: `/diffshub-avatars/${name}.png`, login: name };
}
