import { describe, expect, test } from 'bun:test';

import { buildPaletteItems } from '@/lib/commandPaletteItems';

const RECENTS = [
  { path: '/oven-sh/bun/pull/1', title: 'Fix leak', viewedAt: 2 },
  { path: '/acme/widgets/compare/a...b', viewedAt: 1 },
];

describe('buildPaletteItems', () => {
  test('empty query leads with actions so /pulls is the default', () => {
    const sections = buildPaletteItems({
      query: '',
      recents: RECENTS,
      pinned: ['ziglang/zig'],
      suggestions: [],
    });
    expect(sections.map((section) => section.heading)).toEqual([
      'Actions',
      'Recent',
      'Pinned repositories',
    ]);
    expect(sections[0]?.items[0]?.action).toEqual({
      type: 'navigate',
      path: '/pulls',
    });
    expect(sections[0]?.items[1]?.action).toEqual({
      type: 'navigate',
      path: '/browse',
    });
    expect(sections[1]?.items[0]).toMatchObject({
      label: 'Fix leak',
      detail: '/oven-sh/bun/pull/1',
      action: { type: 'navigate', path: '/oven-sh/bun/pull/1' },
    });
    expect(sections[2]?.items[0]?.action).toEqual({
      type: 'fill',
      value: 'ziglang/zig#',
    });
  });

  test('empty query omits empty recents/pins sections', () => {
    const sections = buildPaletteItems({
      query: '',
      recents: [],
      pinned: [],
      suggestions: [],
    });
    expect(sections.map((section) => section.heading)).toEqual(['Actions']);
  });

  test('direct-resolvable query gets a Go to item', () => {
    const sections = buildPaletteItems({
      query: 'oven-sh/bun#123',
      recents: [],
      pinned: [],
      suggestions: [],
    });
    expect(sections[0]?.heading).toBe('Go to');
    expect(sections[0]?.items[0]?.action).toEqual({
      type: 'navigate',
      path: '/oven-sh/bun/pull/123',
    });
  });

  test('bare repo prefix suppresses the Go to item while narrowing', () => {
    const sections = buildPaletteItems({
      query: 'oven-sh/bun',
      recents: [],
      pinned: [],
      suggestions: [
        { key: 'repo:oven-sh/bun', label: 'oven-sh/bun', fill: 'oven-sh/bun#' },
      ],
    });
    // The file browser rides along after the narrowing results, so Enter
    // still defaults to the pull search.
    expect(sections.map((section) => section.heading)).toEqual([
      'Repositories',
      'Browse',
    ]);
    expect(sections[1]?.items[0]?.action).toMatchObject({
      type: 'navigate',
      path: '/oven-sh/bun',
    });
  });

  test('owner/repo@ref goes straight to the file browser', () => {
    const sections = buildPaletteItems({
      query: 'oven-sh/bun@feature/rope-strings',
      recents: [],
      pinned: [],
      suggestions: [],
    });
    expect(sections.map((section) => section.heading)).toEqual(['Go to']);
    expect(sections[0]?.items).toHaveLength(1);
    expect(sections[0]?.items[0]?.action).toMatchObject({
      type: 'navigate',
      path: '/oven-sh/bun/tree/feature/rope-strings',
    });
  });

  test('owner/repo@sha offers both the tree and the commit diff', () => {
    const sections = buildPaletteItems({
      query: 'oven-sh/bun@0ab12cd',
      recents: [],
      pinned: [],
      suggestions: [],
    });
    expect(sections[0]?.items.map((item) => item.action)).toMatchObject([
      { type: 'navigate', path: '/oven-sh/bun/tree/0ab12cd' },
      { type: 'navigate', path: '/oven-sh/bun/commit/0ab12cd' },
    ]);
  });

  test('owner/repo@ with no ref browses the default branch', () => {
    const sections = buildPaletteItems({
      query: 'oven-sh/bun@',
      recents: [],
      pinned: [],
      suggestions: [],
    });
    expect(sections[0]?.items[0]?.action).toMatchObject({
      type: 'navigate',
      path: '/oven-sh/bun',
    });
  });

  test('splits suggestions into pull and repo sections, pulls first', () => {
    const sections = buildPaletteItems({
      query: 'oven-sh/bun#fix',
      recents: [],
      pinned: [],
      suggestions: [
        { key: 'repo:oven-sh/bun', label: 'oven-sh/bun', fill: 'oven-sh/bun#' },
        {
          key: 'pull:42',
          label: '#42 · Fix the leak',
          fill: 'oven-sh/bun#42',
        },
      ],
    });
    expect(sections.map((section) => section.heading)).toEqual([
      'Pull requests',
      'Repositories',
    ]);
    expect(sections[0]?.items[0]?.action).toEqual({
      type: 'navigate',
      path: '/oven-sh/bun/pull/42',
      recordTitle: 'Fix the leak',
    });
  });
});
