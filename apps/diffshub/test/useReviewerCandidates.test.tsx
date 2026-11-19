/** @jsxImportSource react */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  type ReviewerCandidatesResult,
  useReviewerCandidates,
} from '../components/useReviewerCandidates';

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

const REPO = { owner: 'acme', repo: 'widgets' };
// The harness's latest hook result, published from an effect.
const probe: { current: ReviewerCandidatesResult | null | undefined } = {
  current: undefined,
};
let root: Root;

function Harness({ query }: { query: string }) {
  const result = useReviewerCandidates(REPO, query);
  useEffect(() => {
    probe.current = result;
  });
  return null;
}

const render = (query: string) =>
  act(() => root.render(<Harness query={query} />));

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 400)));

const logins = () =>
  probe.current?.kind === 'ready'
    ? probe.current.candidates.map((candidate) => candidate.login)
    : null;

beforeAll(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    localStorage: dom.window.localStorage,
    window: dom.window,
  });
  // Answers each search with one candidate named after the query.
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const q = new URL(String(input), 'https://diffshub.test').searchParams.get(
      'q'
    );
    return Promise.resolve(
      Response.json({ candidates: [{ login: `user-${q}` }] })
    );
  }) as typeof fetch;
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

describe('useReviewerCandidates', () => {
  test("never answers with the previous search's results", async () => {
    render('oct');
    await settle();
    expect(logins()).toEqual(['user-oct']);
    // Typing a new search: until it settles, there are no results to pick
    // from (Enter would otherwise act on user-oct).
    render('hub');
    expect(probe.current).toBeNull();
    await settle();
    expect(logins()).toEqual(['user-hub']);
  });
});
