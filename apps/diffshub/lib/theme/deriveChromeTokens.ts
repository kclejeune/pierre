/**
 * deriveChromeTokens derives diffshub's contrast-heavy "chrome" token set — the
 * opinionated app palette (most-legible foreground, derived muted text,
 * color-mix surfaces, luminance-based status tints).
 *
 * Surfaces come resolved from normalizeThemeColors, but the foreground candidate
 * list is read from the raw theme colors in design-intent order, so the contrast
 * pass can compare sideBar.foreground vs editor.foreground vs theme.fg against
 * each other (the resolved/collapsed sidebar fg has already discarded that).
 */
import type { ThemeLike } from '@pierre/theming';
import { colorUtils, normalizeThemeColors } from '@pierre/theming/color';

// The opinionated app-chrome token set diffshubChromeMapping maps onto its CSS
// variables. Moved out of @pierre/theming (which now stays neutral); the shape
// is unchanged from the token set the package used to ship.
export interface ChromeTokens {
  additionFg: string;
  // Inline thread cards in the diff, which sit on the code (editor) surface
  // rather than the sidebar's; see `annotationBg` below.
  annotationBg: string;
  annotationBorder: string;
  annotationHoverBorder: string;
  // Recessed fills inside a thread card (inline code, the reply field): on
  // dark themes the code surface itself, so code in a comment reads as code.
  annotationInsetBg: string;
  // The card's text tiers around the body text (`fg`): author names and
  // inline code a step brighter (darker on light themes), timestamps and
  // badges a step quieter. Many themes' muted text equals their body text,
  // so both derive from `fg` rather than the theme's own muted color.
  annotationMutedFg: string;
  annotationStrongFg: string;
  background: string;
  border: string;
  borderOpaque: string;
  // Inline cards (the sidebar's comment rows): one elevation step below
  // `surface` (popovers), in the theme's own tint.
  cardBg: string;
  cardBorder: string;
  cardHoverBg: string;
  deletionFg: string;
  // The code surface (editor.background); lets panes that sit under a
  // CodeView extend its background past the end of the content.
  editorBg?: string;
  fg: string;
  mutedFg: string;
  ring: string;
  scrollbarThumb?: string;
  scrollbarTrack?: string;
  // A segmented control's selected segment, which must stand clear of its
  // track (`surfaceHover`): lighter than it on dark themes, the lifted
  // surface on light ones.
  segmentSelectedBg: string;
  separator: string;
  surface: string;
  surfaceBorder: string;
  surfaceHover: string;
  surfaceSelected: string;
  surfaceShadow: string;
}

// Muted-text floor (WCAG AA normal text); used to decide whether the theme's
// descriptionForeground is readable enough to keep on the chrome surface.
const MIN_MUTED_RATIO = 4.5;

// Mix weight (percent of the surface's own foreground blended into its
// background) for the opaque chrome borders and the inter-file diff separator.
// Shared so both lines carry the same visual weight across themes.
const DIFF_BORDER_MIX = 22;

// Percent of white mixed into a light theme's sidebar for the chrome
// background (see `canvas`).
const LIGHT_CANVAS_LIFT = 35;

const cache = new WeakMap<ThemeLike, ChromeTokens | undefined>();

// Returns the theme's descriptionForeground when it's readable enough
// (>= MIN_MUTED_RATIO against the chrome bg). Hex-with-alpha values like
// aurora-x's `#576daf79` are composited over the bg first, since rgba previews
// don't reach AA on their own. Returns undefined when the value is missing,
// unparseable, or fails the contrast bar — letting the call site fall back to a
// derived muted.
function pickReadableMuted(
  bg: string | undefined,
  mutedCandidate: string | undefined
): string | undefined {
  if (mutedCandidate == null || mutedCandidate === '') return undefined;
  const composited =
    colorUtils.compositeOverBg(mutedCandidate, bg) ?? mutedCandidate;
  const compositedL = colorUtils.relativeLuminance(composited);
  const bgL = colorUtils.relativeLuminance(bg);
  if (compositedL == null || bgL == null) {
    // Can't measure — trust the designer's value rather than second-guess
    // exotic non-hex formats (var(...), color-mix(...), named colors).
    return mutedCandidate;
  }
  return colorUtils.contrastRatio(bgL, compositedL) >= MIN_MUTED_RATIO
    ? mutedCandidate
    : undefined;
}

// Raises a surface by `step` LCH lightness (0-100) while keeping its chroma
// and hue (CSS relative color syntax), the one move behind the elevation
// scale. LCH, not OKLCH: Chrome treats the hue of near-grey theme surfaces
// as missing in OKLCH (#282c34 resolves to hue `none`), which tints the lift
// red; LCH keeps it.
function lift(base: string, step: number): string {
  return `lch(from ${base} calc(l + ${step}) c h)`;
}

// Reads a Shiki/VS Code-style theme and returns the chrome token set, or
// undefined when the theme yields no legible foreground (the degenerate,
// bg-only case — real themes always produce an fg).
export function deriveChromeTokens(theme: ThemeLike): ChromeTokens | undefined {
  const cached = cache.get(theme);
  if (cached !== undefined || cache.has(theme)) return cached;

  // Resolved surfaces (shared with trees) come from normalizeThemeColors; the
  // raw colors map drives the design-intent foreground candidate list.
  const rawColors = theme.colors ?? {};
  const resolved = normalizeThemeColors(theme).colors ?? {};

  const sidebarBg = resolved['sideBar.background'];
  // The contrast pass needs the raw candidate LIST (design-intent order), not
  // the collapsed sidebar fg, so it can compare each against the surface.
  const fg = colorUtils.pickReadableForeground(sidebarBg, [
    rawColors['sideBar.foreground'],
    rawColors['editor.foreground'],
    theme.fg,
  ]);
  // No foreground means no meaningful chrome.
  if (fg == null) {
    cache.set(theme, undefined);
    return undefined;
  }

  const editorBg = resolved['editor.background'] ?? sidebarBg;
  const editorFg = resolved['editor.foreground'] ?? fg;
  const surfaceIsDark = colorUtils.isDarkSurface(sidebarBg, fg);
  // The chrome's own background: the theme's sidebar, brightened a little on
  // light themes (whose sidebars are often a flat mid-grey) so the page reads
  // light while raised surfaces still sit lighter than it.
  const canvas =
    sidebarBg == null || surfaceIsDark
      ? sidebarBg
      : `color-mix(in srgb, white ${LIGHT_CANVAS_LIFT}%, ${sidebarBg})`;
  // Cards layer onto that background so they stay on-palette whether the
  // theme is "light" or "dark".
  const cardBase = canvas ?? 'transparent';
  const muted =
    pickReadableMuted(sidebarBg, rawColors['descriptionForeground']) ??
    colorUtils.deriveMutedFg(fg, sidebarBg);
  // Opaque chrome border (header bottom, sidebar edge); shares DIFF_BORDER_MIX
  // with the diff separator so the two read as one system.
  const borderOpaque = `color-mix(in srgb, ${fg} ${DIFF_BORDER_MIX}%, ${cardBase})`;
  // Hairline between diff files. When the editor surface matches the sidebar
  // (the common case) reuse the chrome border verbatim so the separator can't
  // drift; only when the palettes genuinely diverge (slack-ochin) derive it
  // from the editor surface so it contrasts the diff body.
  const separator =
    editorBg == null || colorUtils.surfacesMatch(editorBg, sidebarBg)
      ? borderOpaque
      : `color-mix(in srgb, ${editorFg} ${DIFF_BORDER_MIX}%, ${editorBg})`;

  // Raised surfaces share one elevation scale: each is its base surface with
  // a fixed lightness step and the base's own chroma and hue, so cards
  // and popovers stay in the theme's tint instead of washing out toward
  // neutral white (light themes) or grey (dark ones). Popovers sit at the top
  // so a menu always reads above the card it opens over. Dark themes need
  // bigger steps, since lightness differences read smaller near black.
  const surface = lift(cardBase, surfaceIsDark ? 8 : 3);
  const cardBg = lift(cardBase, surfaceIsDark ? 5 : 2);
  const cardHoverBg = `color-mix(in srgb, ${fg} ${surfaceIsDark ? 14 : 4}%, ${cardBase})`;
  const cardBorder = `color-mix(in srgb, ${fg} ${surfaceIsDark ? 14 : 16}%, ${cardBase})`;
  // The selected segment of a segmented control: a strong fg mix on dark
  // themes, where a small lift vanished into the track; the popover level on
  // light ones, already well clear of the darker track.
  const segmentSelectedBg = surfaceIsDark
    ? `color-mix(in srgb, ${fg} 30%, ${cardBase})`
    : surface;

  // Inline thread cards sit on the code surface, which some themes paint
  // lighter than their sidebar (one-dark-pro: #282c34 over #21252b), so they
  // lift from the editor itself, one step below the popover level.
  const annotationBase = editorBg ?? cardBase;
  const editorIsDark =
    editorBg == null
      ? surfaceIsDark
      : colorUtils.isDarkSurface(editorBg, editorFg);
  const annotationBg = lift(annotationBase, editorIsDark ? 4 : 2);
  const surfaceBorder = `color-mix(in srgb, ${fg} 18%, ${cardBase})`;
  const annotationBorder = editorIsDark
    ? `color-mix(in srgb, ${editorFg} 24%, ${annotationBase})`
    : surfaceBorder;
  const annotationHoverBorder = editorIsDark
    ? `color-mix(in srgb, ${editorFg} 34%, ${annotationBase})`
    : `color-mix(in srgb, ${fg} 28%, ${cardBase})`;
  const annotationStrongFg = editorIsDark
    ? `color-mix(in srgb, ${fg} 60%, white)`
    : `color-mix(in srgb, ${fg} 78%, black)`;
  const annotationMutedFg = `color-mix(in srgb, ${fg} 88%, ${annotationBg})`;
  // A dark card sits on the code surface, so the code itself is the inset; a
  // light card is already near the (often white) code, so it darkens slightly.
  const annotationInsetBg = editorIsDark
    ? annotationBase
    : `color-mix(in srgb, ${fg} 7%, ${annotationBg})`;

  const tokens = Object.freeze({
    additionFg: surfaceIsDark ? '#34d399' : '#047857',
    annotationBg,
    annotationBorder,
    annotationHoverBorder,
    annotationInsetBg,
    annotationMutedFg,
    annotationStrongFg,
    background: canvas ?? `color-mix(in srgb, ${fg} 7%, ${cardBase})`,
    border: `color-mix(in srgb, ${fg} 20%, transparent)`,
    borderOpaque,
    cardBg,
    cardBorder,
    cardHoverBg,
    deletionFg: surfaceIsDark ? '#fb7185' : '#be123c',
    editorBg: editorBg ?? undefined,
    fg,
    mutedFg: muted,
    ring: fg,
    scrollbarThumb:
      editorBg != null
        ? editorIsDark
          ? `color-mix(in lab, ${editorBg} 80%, white)`
          : `color-mix(in lab, ${editorBg} 85%, black)`
        : undefined,
    scrollbarTrack: editorBg ?? undefined,
    segmentSelectedBg,
    separator,
    surface,
    surfaceBorder,
    surfaceHover: `color-mix(in srgb, ${fg} 14%, ${cardBase})`,
    surfaceSelected: `color-mix(in srgb, ${fg} 20%, ${cardBase})`,
    surfaceShadow: surfaceIsDark
      ? '0 8px 16px rgb(0 0 0 / 0.07), 0 2px 4px rgb(0 0 0 / 0.05)'
      : '0 8px 24px rgb(0 0 0 / 0.09), 0 2px 6px rgb(0 0 0 / 0.06)',
  });
  cache.set(theme, tokens);
  return tokens;
}
