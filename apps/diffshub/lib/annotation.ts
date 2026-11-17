import type { CommentAuthor } from '@/lib/types';

// The border color shared by annotation cards and the surfaces inside them
// (editor chrome, overview cards); pair it with a border-width utility.
export const annotationBorderColor =
  'border-[var(--diffshub-annotation-border,var(--color-border))]';

// Outline buttons inside comment composers and threads (Cancel, Add single
// comment, Resolve). The stock outline variant fills with the page palette
// (white in the diff, the theme surface in the sidebar), so the same button
// looked different in each place. These stay transparent over whatever
// surface holds them (the inline card, the sidebar) and share the annotation
// border, so they read as the same outlined button everywhere. Pass as the
// Button's className alongside variant="outline".
export const composerSecondaryButtonClass =
  'border-[var(--diffshub-annotation-border,var(--color-border))] bg-transparent text-[var(--diffshub-annotation-fg,var(--color-foreground))] shadow-none hover:bg-[color-mix(in_srgb,currentColor_8%,transparent)] hover:text-[var(--diffshub-annotation-fg,var(--color-foreground))] dark:border-[var(--diffshub-annotation-border,var(--color-border))] dark:hover:bg-[color-mix(in_srgb,currentColor_8%,transparent)]';

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

// Picks a random demo persona as the comment author. Used as the fallback
// identity when no GitHub token is saved (or the token cannot resolve /user);
// intended as a useState lazy initializer so each new draft form gets a fresh
// identity on mount.
export function getRandomPersonaAuthor(): CommentAuthor {
  const name = AVATAR_NAMES[Math.floor(Math.random() * AVATAR_NAMES.length)];
  return { avatarUrl: `/diffshub-avatars/${name}.png`, login: name };
}
