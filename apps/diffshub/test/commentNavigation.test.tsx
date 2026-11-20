/** @jsxImportSource react */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  type CommentNavigation,
  useCommentNavigation,
} from '../components/useCommentNavigation';
import type {
  DiffsHubSavedCommentEntry,
  DiffsHubSavedCommentItem,
} from '@/lib/types';

const originalGlobals = {
  document: Reflect.get(globalThis, 'document'),
  HTMLElement: Reflect.get(globalThis, 'HTMLElement'),
  IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT'),
  window: Reflect.get(globalThis, 'window'),
};
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://diffshub.test',
});

function comment(key: string, lineNumber: number): DiffsHubSavedCommentEntry {
  return {
    author: { avatarUrl: '', login: 'octo' },
    itemId: key.split(':')[0] ?? key,
    key,
    lineNumber,
    lineType: 'change',
    message: key,
    participants: [],
    range: { end: lineNumber, side: 'additions', start: lineNumber },
    replyCount: 0,
    side: 'additions',
  };
}

// Two files in diff order, threads in line order within each.
const SECTIONS: DiffsHubSavedCommentItem[] = [
  {
    comments: [comment('a:1', 3), comment('a:2', 9)],
    fileOrder: 0,
    itemId: 'a',
    path: 'a.ts',
  },
  { comments: [comment('b:1', 4)], fileOrder: 1, itemId: 'b', path: 'b.ts' },
];

// The harness's latest navigation and the comments it selected, published
// from an effect.
const probe: { current: CommentNavigation | null; selected: string[] } = {
  current: null,
  selected: [],
};
let root: Root;

function Harness({
  includeDrafts,
  sections,
}: {
  includeDrafts: boolean;
  sections: DiffsHubSavedCommentItem[];
}) {
  const navigation = useCommentNavigation(
    sections,
    (selected) => {
      probe.selected.push(selected.key);
    },
    { includeDrafts }
  );
  useEffect(() => {
    probe.current = navigation;
  });
  return null;
}

// A fresh harness (new key, so no position carried over from an earlier
// test); rerender keeps the current one.
let mountCount = 0;
function mount(
  sections: DiffsHubSavedCommentItem[] = SECTIONS,
  includeDrafts = true
) {
  mountCount += 1;
  rerender(sections, includeDrafts);
  probe.selected = [];
}

function rerender(sections: DiffsHubSavedCommentItem[], includeDrafts = true) {
  act(() =>
    root.render(
      <Harness
        key={mountCount}
        includeDrafts={includeDrafts}
        sections={sections}
      />
    )
  );
}

function navigation(): CommentNavigation {
  if (probe.current == null) {
    throw new Error('harness has not rendered');
  }
  return probe.current;
}

function press(
  key: string,
  options: { metaKey?: boolean; target?: EventTarget } = {}
) {
  const event = new dom.window.KeyboardEvent('keydown', {
    bubbles: true,
    key,
    metaKey: options.metaKey ?? false,
  });
  act(() => {
    (options.target ?? dom.window).dispatchEvent(event);
  });
}

beforeAll(() => {
  Reflect.set(globalThis, 'window', dom.window);
  Reflect.set(globalThis, 'document', dom.window.document);
  Reflect.set(globalThis, 'HTMLElement', dom.window.HTMLElement);
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(dom.window.document.createElement('div'));
});

afterAll(() => {
  act(() => root.unmount());
  for (const [key, value] of Object.entries(originalGlobals)) {
    Reflect.set(globalThis, key, value);
  }
});

describe('useCommentNavigation', () => {
  test('steps through threads in diff order and stops at the ends', () => {
    mount();
    expect(navigation().position).toBe(-1);
    expect(navigation().total).toBe(3);

    for (let step = 0; step < 4; step++) {
      act(() => navigation().goNext());
    }
    // The fourth step had nowhere to go.
    expect(probe.selected).toEqual(['a:1', 'a:2', 'b:1']);
    expect(navigation().position).toBe(2);
    expect(navigation().next).toBeUndefined();

    act(() => navigation().goPrevious());
    expect(probe.selected.at(-1)).toBe('a:2');
  });

  test('previous before any step starts at the last thread', () => {
    mount();
    act(() => navigation().goPrevious());
    expect(probe.selected).toEqual(['b:1']);
  });

  test('n and p step, but not while typing or with a modifier', () => {
    mount();
    press('n');
    press('n');
    press('p');
    expect(probe.selected).toEqual(['a:1', 'a:2', 'a:1']);

    const input = dom.window.document.createElement('input');
    dom.window.document.body.append(input);
    press('n', { target: input });
    press('n', { metaKey: true });
    input.remove();
    expect(probe.selected).toEqual(['a:1', 'a:2', 'a:1']);
  });

  test('a comment selected in the sidebar becomes the current one', () => {
    mount();
    act(() => navigation().select(comment('a:2', 9)));
    expect(navigation().position).toBe(1);
    act(() => navigation().goNext());
    expect(probe.selected).toEqual(['a:2', 'b:1']);
  });

  test('resolved threads are skipped but still anchor a step', () => {
    const [first, second] = SECTIONS;
    // a:2, between the other two threads, is resolved.
    mount([
      {
        ...first,
        comments: [comment('a:1', 3), { ...comment('a:2', 9), resolved: true }],
      },
      second,
    ]);
    expect(navigation().total).toBe(2);
    act(() => navigation().goNext());
    act(() => navigation().goNext());
    expect(probe.selected).toEqual(['a:1', 'b:1']);
    expect(navigation().position).toBe(1);

    // Picked in the sidebar, the resolved thread has no stepper position but
    // steps continue from it in both directions.
    act(() => navigation().select({ ...comment('a:2', 9), resolved: true }));
    expect(navigation().position).toBe(-1);
    expect(navigation().next?.key).toBe('b:1');
    expect(navigation().previous?.key).toBe('a:1');
  });

  test('drafts are visited only when included', () => {
    const [first, second] = SECTIONS;
    // a:1 and b:1 are GitHub conversations; a:2 is a local draft.
    const sections = [
      {
        ...first,
        comments: [
          { ...comment('a:1', 3), reviewThread: true as const },
          comment('a:2', 9),
        ],
      },
      {
        ...second,
        comments: [{ ...comment('b:1', 4), reviewThread: true as const }],
      },
    ];
    mount(sections, false);
    expect(navigation().total).toBe(2);
    act(() => navigation().goNext());
    act(() => navigation().goNext());
    expect(probe.selected).toEqual(['a:1', 'b:1']);

    // Turning drafts back on keeps the position and counts the draft.
    rerender(sections, true);
    expect(navigation().total).toBe(3);
    expect(navigation().position).toBe(2);
    expect(navigation().previous?.key).toBe('a:2');
  });

  test('deleting the current thread restarts from the ends', () => {
    mount();
    act(() => navigation().goNext());
    expect(navigation().position).toBe(0);
    const [first, second] = SECTIONS;
    rerender([{ ...first, comments: first.comments.slice(1) }, second]);
    expect(navigation().position).toBe(-1);
    expect(navigation().next?.key).toBe('a:2');
  });
});
