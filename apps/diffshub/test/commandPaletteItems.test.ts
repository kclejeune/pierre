import { describe, expect, test } from 'bun:test';

import { buildPaletteItems } from '@/lib/commandPaletteItems';

const RECENTS = [
  { path: '/oven-sh/bun/pull/1', title: 'Fix leak', viewedAt: 2 },
  { path: '/acme/widgets/compare/a...b', viewedAt: 1 },
];

describe('buildPaletteItems', () => {
  test('empty query lists recents, pins, and actions in order', () => {
    const sections = buildPaletteItems({
      query: '',
      recents: RECENTS,
      pinned: ['ziglang/zig'],
      suggestions: [],
    });
    expect(sections.map((section) => section.heading)).toEqual([
      'Recent diffs',
      'Pinned repositories',
      'Actions',
    ]);
    expect(sections[0]?.items[0]).toMatchObject({
      label: 'Fix leak',
      detail: '/oven-sh/bun/pull/1',
      action: { type: 'navigate', path: '/oven-sh/bun/pull/1' },
    });
    expect(sections[1]?.items[0]?.action).toEqual({
      type: 'fill',
      value: 'ziglang/zig#',
    });
    expect(sections[2]?.items[0]?.action).toEqual({
      type: 'navigate',
      path: '/pulls',
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
    expect(sections.map((section) => section.heading)).toEqual([
      'Repositories',
    ]);
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
