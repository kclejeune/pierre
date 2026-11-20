import type { CommentAuthor } from '@/lib/types';

// The border color shared by annotation cards and the surfaces inside them
// (editor chrome, overview cards); pair it with a border-width utility.
export const annotationBorderColor =
  'border-[var(--diffshub-annotation-border,var(--color-border))]';

// Re-points the shared foreground, muted, and muted-fill tokens at the card's
// themed tiers (lib/theme/deriveChromeTokens), so everything inside (names,
// timestamps, badges, inline code, the reply field) draws from the theme's
// palette instead of the stock neutral grays, which clash with tinted themes.
// Falls back to the page tokens when no theme tiers are set.
const annotationTextTiers =
  '[--color-foreground:var(--diffshub-annotation-strong-fg,var(--foreground))] [--color-muted-foreground:var(--diffshub-annotation-muted-fg,var(--muted-foreground))] [--color-muted:var(--diffshub-annotation-inset-bg,var(--muted))]';

// An annotation card's surface: rounded border, themed background and text,
// and shadow. Cards add their own spacing and layout on top.
export const annotationCardSurface = `rounded-xl border ${annotationBorderColor} bg-[var(--diffshub-annotation-bg,var(--color-card))] font-sans text-[var(--diffshub-annotation-fg,var(--color-card-foreground))] shadow-[var(--diffshub-annotation-shadow,0_2px_4px_rgb(0_0_0_/_0.025),0_4px_8px_rgb(0_0_0_/_0.025))] ${annotationTextTiers}`;

export const annotationCardBase = `m-2 flex max-w-[600px] gap-2.5 bg-clip-padding p-3 ${annotationCardSurface}`;

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

// Picks a random demo persona as the comment author. Used as the fallback
// identity when no GitHub token is saved (or the token cannot resolve /user);
// intended as a useState lazy initializer so each new draft form gets a fresh
// identity on mount.
export function getRandomPersonaAuthor(): CommentAuthor {
  const name = AVATAR_NAMES[Math.floor(Math.random() * AVATAR_NAMES.length)];
  return { avatarUrl: `/diffshub-avatars/${name}.png`, login: name };
}
