/** @jsxImportSource react */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { usePullSelection } from '../components/usePullSelection';
import type { PullSummary } from '@/lib/githubPullSummaries';
import { buildPullRows, groupPulls } from '@/lib/pullGroups';

const originalGlobals = {
  document: Reflect.get(globalThis, 'document'),
  window: Reflect.get(globalThis, 'window'),
  IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT'),
};
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://diffshub.test',
});

function pull(repo: string, title = repo): PullSummary {
  return {
    authorLogin: 'renovate',
    number: 1,
    owner: 'acme',
    repo,
    state: 'open',
    title,
    updatedAt: '2026-11-18T00:00:00Z',
    viewerPath: `/acme/${repo}/pull/1`,
  };
}

type Selection = ReturnType<typeof usePullSelection>;
// The harness's latest hook result, published from an effect.
const probe: { current: Selection | null } = { current: null };
let root: Root;

function Harness({
  locked = false,
  pulls,
  search,
}: {
  locked?: boolean;
  pulls: PullSummary[];
  search: string;
}) {
  const rows = buildPullRows(groupPulls(pulls), new Set());
  const selection = usePullSelection(pulls, rows, search, locked);
  useEffect(() => {
    probe.current = selection;
  });
  return null;
}

function render(props: Parameters<typeof Harness>[0]) {
  act(() => root.render(<Harness {...props} />));
}

function selection(): Selection {
  if (probe.current == null) {
    throw new Error('The harness has not rendered.');
  }
  return probe.current;
}

const checkedRepos = () => selection().checked.map((entry) => entry.repo);

beforeAll(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.render(null));
});

afterAll(() => {
  act(() => root.unmount());
  Object.assign(globalThis, originalGlobals);
});

describe('usePullSelection', () => {
  const a = pull('a');
  const b = pull('b');
  const c = pull('c');

  test('a search change clears the selection for good', () => {
    render({ pulls: [a, b], search: 'A' });
    act(() => selection().toggleRow('acme/a#1', false));
    expect(checkedRepos()).toEqual(['a']);
    render({ pulls: [a, b], search: 'B' });
    expect(checkedRepos()).toEqual([]);
    // Coming back doesn't restore the old picks.
    render({ pulls: [a, b], search: 'A' });
    expect(checkedRepos()).toEqual([]);
  });

  test('keeps pulls a refetch dropped, after the ones still listed', () => {
    render({ pulls: [a, b, c], search: 'A' });
    act(() => selection().set([c, a]));
    // A refresh reloads only the first page; c falls off it.
    render({ pulls: [a, b], search: 'A' });
    expect(checkedRepos()).toEqual(['a', 'c']);
    // Two checked pulls, two loaded, but b isn't one of them: "Select all"
    // still has a row to add.
    expect(selection().allLoadedChecked).toBe(false);
    act(() => selection().set([...selection().checked, a, b]));
    expect(selection().allLoadedChecked).toBe(true);
    expect(checkedRepos()).toEqual(['a', 'b', 'c']);
  });

  test('shift-click checks the range from the last row flipped', () => {
    render({ pulls: [a, b, c], search: 'A' });
    act(() => selection().toggleRow('acme/a#1', false));
    act(() => selection().toggleRow('acme/c#1', true));
    expect(checkedRepos()).toEqual(['a', 'b', 'c']);
  });

  test('locked: toggling and clearing do nothing', () => {
    render({ pulls: [a, b], search: 'A' });
    act(() => selection().toggleRow('acme/a#1', false));
    render({ locked: true, pulls: [a, b], search: 'A' });
    act(() => selection().toggleRow('acme/b#1', false));
    act(() => selection().clear());
    expect(checkedRepos()).toEqual(['a']);
  });

  test('a batch result only lands in the search it ran on', () => {
    render({ pulls: [a, b], search: 'A' });
    render({ pulls: [a, b], search: 'B' });
    act(() => selection().set([a], 'A'));
    expect(checkedRepos()).toEqual([]);
    act(() => selection().set([a], 'B'));
    expect(checkedRepos()).toEqual(['a']);
  });
});
