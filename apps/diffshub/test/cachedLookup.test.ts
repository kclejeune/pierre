import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { createCachedLookup } from '../lib/cachedLookup';
import { installJsdomGlobals } from '../lib/test/jsdomGlobals';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost',
});

let restoreGlobals: () => void;

beforeAll(() => {
  restoreGlobals = installJsdomGlobals({
    document: dom.window.document,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    window: dom.window,
  });
});

afterAll(() => {
  restoreGlobals();
  dom.window.close();
});

describe('createCachedLookup', () => {
  test('expires failed lookups so transient errors can retry', async () => {
    let calls = 0;
    const lookup = createCachedLookup(() => {
      calls += 1;
      return Promise.resolve(null);
    });

    try {
      setSystemTime(new Date('2026-09-08T12:00:00Z'));
      await lookup.load('octocat');
      await lookup.load('octocat');
      expect(calls).toBe(1);

      setSystemTime(new Date('2026-09-08T12:00:31Z'));
      await lookup.load('octocat');
      expect(calls).toBe(2);
    } finally {
      setSystemTime();
    }
  });

  test('evicts the least recently used resolved value', async () => {
    let calls = 0;
    const lookup = createCachedLookup(
      (key: string) => {
        calls += 1;
        return Promise.resolve(key);
      },
      { maxEntries: 2 }
    );

    await lookup.load('first');
    await lookup.load('second');
    await lookup.load('first');
    await lookup.load('third');
    await lookup.load('second');

    expect(calls).toBe(4);
  });

  test('refreshes an expired value while its consumer remains mounted', async () => {
    let calls = 0;
    const lookup = createCachedLookup(
      () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve('first')
          : new Promise<string>(() => undefined);
      },
      { valueTTL: 5 }
    );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    function Value() {
      return createElement('span', null, lookup.useValue('key') ?? 'loading');
    }

    try {
      await act(async () => {
        root.render(createElement(Value));
        await Promise.resolve();
      });
      expect(container.textContent).toBe('first');

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(calls).toBe(2);
      expect(container.textContent).toBe('first');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
