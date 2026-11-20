import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';

import { claimTabPullQueue, savePullQueue } from '@/lib/pullQueue';

const originalWindow = Reflect.get(globalThis, 'window');
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://diffshub.test/acme/a/pull/1',
});
Reflect.set(globalThis, 'window', dom.window);

afterAll(() => {
  Reflect.set(globalThis, 'window', originalWindow);
});

const queue = {
  items: [{ path: '/acme/a/pull/1', title: 'one' }],
  listPath: '/pulls',
};

function visit(path: string) {
  dom.window.history.replaceState(null, '', path);
}

beforeEach(() => {
  dom.window.localStorage.clear();
  dom.window.sessionStorage.clear();
});

describe('claimTabPullQueue', () => {
  test('moves a saved queue from the URL into the tab', () => {
    savePullQueue('abc', queue);
    visit('/acme/a/pull/1?queue=abc&x=1#target=f');
    expect(claimTabPullQueue()?.items).toEqual(queue.items);
    expect(dom.window.location.search).toBe('?x=1');
    expect(dom.window.location.hash).toBe('#target=f');
    // Later pages in the tab keep it without the parameter.
    visit('/acme/a/pull/1');
    expect(claimTabPullQueue()?.items).toEqual(queue.items);
  });

  test("strips a queue this browser didn't save, keeping the tab's own", () => {
    savePullQueue('abc', queue);
    visit('/acme/a/pull/1?queue=abc');
    claimTabPullQueue();
    visit('/acme/a/pull/1?queue=zzz');
    expect(claimTabPullQueue()?.items).toEqual(queue.items);
    expect(dom.window.location.search).toBe('');
  });

  test('strips a malformed id too', () => {
    visit('/acme/a/pull/1?queue=../etc');
    expect(claimTabPullQueue()).toBeNull();
    expect(dom.window.location.search).toBe('');
  });
});
