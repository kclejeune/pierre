import type { DiffIndicators } from '@pierre/diffs';

// Persisted viewer display preferences, stored as one localStorage object so
// they survive reloads like the theme picks do. Every field is optional: only
// values the user has actually set are written, and unknown/invalid stored
// values fall back to the in-app defaults on load.

const STORAGE_KEY = 'diffshub.display-settings';

export interface DiffsHubDisplaySettings {
  collapseMode?: 'expanded' | 'collapsed';
  diffIndicators?: DiffIndicators;
  diffStyle?: 'split' | 'unified';
  lineNumbers?: boolean;
  markdownView?: 'rendered' | 'raw';
  overflow?: 'wrap' | 'scroll';
  showBackgrounds?: boolean;
}

export function loadDisplaySettings(): DiffsHubDisplaySettings {
  let parsed: unknown;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw == null) {
      return {};
    }
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

export function saveDisplaySettings(settings: DiffsHubDisplaySettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable; settings still hold for this session.
  }
}
