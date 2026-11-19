/** @jsxImportSource react */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { usePullDetailsModel } from '../components/PullDetailsControl';
import { notifyPullChanged } from '@/lib/pullChangeEvents';
import type { PullInfo } from '@/lib/pullInfoClient';

const originalGlobals = {
  document: Reflect.get(globalThis, 'document'),
  fetch: globalThis.fetch,
  IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT'),
  localStorage: Reflect.get(globalThis, 'localStorage'),
  window: Reflect.get(globalThis, 'window'),
};
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://diffshub.test',
});

const PULL = { number: '7', owner: 'acme', repo: 'widgets' };
const PULL_INFO = {
  details: {
    body: '',
    draft: false,
    labels: [],
    mergeable: true,
    mergeableState: 'clean',
    reviewers: [],
    state: 'open',
    title: 'Tune the warp core',
  },
  headSha: 'abc123',
  number: '7',
} as unknown as PullInfo;

// The harness's latest model, published from an effect.
const probe: { current: ReturnType<typeof usePullDetailsModel> | null } = {
  current: null,
};
let root: Root;

function Harness() {
  const model = usePullDetailsModel({
    canWrite: true,
    conversations: null,
    getGitHubToken: () => 'token',
    githubTokenVersion: 0,
    pullInfo: PULL_INFO,
    pullRequest: PULL,
  });
  useEffect(() => {
    probe.current = model;
  });
  return null;
}

// Supplement reads in the order they were sent; each resolves when the test
// calls its `answer` with the verdict it should report.
const reads: { answer(state: string): void }[] = [];

beforeAll(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: dom.window.localStorage,
    window: dom.window,
  });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      if (!String(input).startsWith('/api/pull-details')) {
        reject(new Error(`unexpected fetch ${String(input)}`));
        return;
      }
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('Aborted', 'AbortError'))
      );
      reads.push({
        answer: (state) =>
          resolve(
            Response.json({
              reviews: [{ login: 'octocat', state }],
            })
          ),
      });
    })) as typeof fetch;
  root = createRoot(document.createElement('div'));
});

afterAll(() => {
  act(() => root.unmount());
  globalThis.fetch = originalGlobals.fetch;
  Object.assign(globalThis, {
    document: originalGlobals.document,
    IS_REACT_ACT_ENVIRONMENT: originalGlobals.IS_REACT_ACT_ENVIRONMENT,
    localStorage: originalGlobals.localStorage,
    window: originalGlobals.window,
  });
});

describe('usePullDetailsModel', () => {
  test('a review landing mid-read restarts the supplement read', async () => {
    await act(async () => {
      root.render(<Harness />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The eager load is in flight when the review lands.
    expect(reads).toHaveLength(1);
    act(() => notifyPullChanged(PULL));
    expect(reads).toHaveLength(2);
    // The read from before the review answers late; it must not win.
    await act(async () => {
      reads[1]?.answer('APPROVED');
      reads[0]?.answer('COMMENTED');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const supplement = probe.current?.supplement;
    expect(supplement?.kind).toBe('ready');
    expect(
      supplement?.kind === 'ready'
        ? (supplement.value as { reviews?: { state: string }[] }).reviews?.[0]
            ?.state
        : null
    ).toBe('APPROVED');
  });
});
