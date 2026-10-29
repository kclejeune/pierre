import type { DiffIndicators } from '@pierre/diffs';

import { readSyncedItem, writeSyncedItem } from './preferenceSync';

// Persisted viewer display preferences, stored as one synced preference
// (lib/preferenceSync) so they survive reloads and follow signed-in viewers
// across browsers, like the theme picks do. Every field is optional: only
// values the user has actually set are written, and unknown/invalid stored
// values fall back to the in-app defaults on load.

export interface DiffsHubDisplaySettings {
  collapseMode?: 'expanded' | 'collapsed';
  diffIndicators?: DiffIndicators;
  diffStyle?: 'split' | 'unified';
  lineNumbers?: boolean;
  markdownView?: 'rendered' | 'raw';
  overflow?: 'wrap' | 'scroll';
  showBackgrounds?: boolean;
}

// What the viewer shows for a setting nobody has picked. diffStyle has no
// entry: without a pick it follows the viewport (split on desktop, unified on
// mobile).
export const DEFAULT_DISPLAY_SETTINGS = {
  collapseMode: 'expanded',
  diffIndicators: 'bars',
  lineNumbers: true,
  markdownView: 'raw',
  overflow: 'scroll',
  showBackgrounds: true,
} as const satisfies Required<Omit<DiffsHubDisplaySettings, 'diffStyle'>>;

export function loadDisplaySettings(): DiffsHubDisplaySettings {
  const raw = readSyncedItem('displaySettings');
  if (raw == null) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed == null) {
    return {};
  }
  const record = parsed as Record<string, unknown>;
  const settings: DiffsHubDisplaySettings = {};
  if (
    record.collapseMode === 'expanded' ||
    record.collapseMode === 'collapsed'
  ) {
    settings.collapseMode = record.collapseMode;
  }
  if (
    record.diffIndicators === 'bars' ||
    record.diffIndicators === 'classic' ||
    record.diffIndicators === 'none'
  ) {
    settings.diffIndicators = record.diffIndicators;
  }
  if (record.diffStyle === 'split' || record.diffStyle === 'unified') {
    settings.diffStyle = record.diffStyle;
  }
  if (typeof record.lineNumbers === 'boolean') {
    settings.lineNumbers = record.lineNumbers;
  }
  if (record.markdownView === 'rendered' || record.markdownView === 'raw') {
    settings.markdownView = record.markdownView;
  }
  if (record.overflow === 'wrap' || record.overflow === 'scroll') {
    settings.overflow = record.overflow;
  }
  if (typeof record.showBackgrounds === 'boolean') {
    settings.showBackgrounds = record.showBackgrounds;
  }
  return settings;
}

// Records settings the viewer just changed, on top of what is already stored.
// Called from user actions only (never to save defaults on load), so only
// values the viewer actually picked are written and synced.
export function updateDisplaySettings(patch: DiffsHubDisplaySettings): void {
  writeSyncedItem(
    'displaySettings',
    JSON.stringify({ ...loadDisplaySettings(), ...patch })
  );
}
