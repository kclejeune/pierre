import { describe, expect, test } from 'bun:test';

import { createLimitedFetch } from '@/lib/concurrencyLimit';
import { type PlainFetch } from '@/lib/plainFetch';

describe('createLimitedFetch', () => {
  test('never runs more than the limit at once and serves waiters in order', async () => {
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const fetcher = (async (input: unknown) => {
      started.push(Number(String(input)));
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return new Response('ok');
    }) as typeof fetch;
    const limited = createLimitedFetch(3, fetcher);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => limited(String(index)))
    );
    expect(peak).toBe(3);
    expect(started).toEqual(Array.from({ length: 20 }, (_, index) => index));
  });

  test('a failed request frees its slot', async () => {
    let calls = 0;
    const fetcher: PlainFetch = () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error('network'))
        : Promise.resolve(new Response('ok'));
    };
    const limited = createLimitedFetch(1, fetcher);
    const results = await Promise.allSettled([limited('a'), limited('b')]);
    expect(results.map((result) => result.status)).toEqual([
      'rejected',
      'fulfilled',
    ]);
  });

  test('aborting a queued request rejects it and frees its place in line', async () => {
    let finishFirst = () => {};
    const started: string[] = [];
    const fetcher: PlainFetch = (input) => {
      started.push(String(input));
      return String(input) === 'a'
        ? new Promise((resolve) => {
            finishFirst = () => resolve(new Response('ok'));
          })
        : Promise.resolve(new Response('ok'));
    };
    const limited = createLimitedFetch(1, fetcher);
    const first = limited('a');
    const controller = new AbortController();
    const queued = limited('b', { signal: controller.signal });
    const after = limited('c');
    controller.abort(new Error('client went away'));
    expect(await queued.catch((thrown: unknown) => thrown)).toEqual(
      new Error('client went away')
    );
    finishFirst();
    await Promise.all([first, after]);
    expect(started).toEqual(['a', 'c']);
    // An already-aborted signal never takes a slot.
    expect(
      await limited('d', { signal: controller.signal }).catch(
        (thrown: unknown) => thrown
      )
    ).toBeInstanceOf(Error);
    expect(started).toEqual(['a', 'c']);
  });
});
