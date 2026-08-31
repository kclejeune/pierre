/** @jsxImportSource react */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { createCachedLookup } from '../lib/cachedLookup';
import { installJsdomGlobals } from '../lib/test/jsdomGlobals';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
let restoreGlobals: () => void;

beforeAll(() => {
  restoreGlobals = installJsdomGlobals({
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    window: dom.window,
  });
});

afterAll(() => {
  restoreGlobals();
  dom.window.close();
});

describe('createCachedLookup', () => {
  test('does not expose the previous key while the next key resolves', async () => {
    const resolveByKey = new Map<string, (value: string) => void>();
    const lookup = createCachedLookup(
      (key: string) =>
        new Promise<string>((resolve) => resolveByKey.set(key, resolve))
    );
    const container = document.createElement('div');
    const root = createRoot(container);
    const Probe = ({ lookupKey }: { lookupKey: string }) => (
      <span>{lookup.useValue(lookupKey) ?? 'unresolved'}</span>
    );

    try {
      act(() => {
        root.render(<Probe lookupKey="first" />);
      });
      await act(() => {
        resolveByKey.get('first')?.('first value');
        return Promise.resolve();
      });
      expect(container.textContent).toBe('first value');

      act(() => {
        root.render(<Probe lookupKey="second" />);
      });
      expect(container.textContent).toBe('unresolved');

      await act(() => {
        resolveByKey.get('second')?.('second value');
        return Promise.resolve();
      });
      expect(container.textContent).toBe('second value');
    } finally {
      act(() => root.unmount());
    }
  });
});
