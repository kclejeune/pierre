import { describe, expect, test } from 'bun:test';

import { createInertAssetResponse } from '../lib/inertAssetResponse';
import {
  createJSONResponse,
  createPrivateJSONResponse,
} from '../lib/jsonResponse';

describe('authenticated asset response caching', () => {
  test('varies private browser responses by authorization', () => {
    const response = createInertAssetResponse(
      new Response('image', {
        headers: { 'Content-Type': 'image/png' },
      })
    );

    expect(response.headers.get('cache-control')).toBe('private, max-age=300');
    expect(response.headers.get('vary')).toBe('Authorization');
  });

  test('allows deployment avatar responses to stay in the browser for one hour', () => {
    const response = createInertAssetResponse(
      new Response('avatar', {
        headers: { 'Content-Type': 'image/png' },
      }),
      { maxAgeSeconds: 3600 }
    );

    expect(response.headers.get('cache-control')).toBe('private, max-age=3600');
    expect(response.headers.get('vary')).toBe('Authorization');
  });
});

describe('authenticated JSON response caching', () => {
  test('keeps ordinary and error responses out of caches', () => {
    const response = createJSONResponse({ error: 'nope' }, { status: 502 });

    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toBe('Authorization');
  });

  test('creates private freshness headers without weakening authorization variance', () => {
    const response = createPrivateJSONResponse({ value: true }, 60);

    expect(response.headers.get('cache-control')).toBe('private, max-age=60');
    expect(response.headers.get('vary')).toBe('Authorization');
  });

  test('marks commit-addressed responses immutable', () => {
    const response = createPrivateJSONResponse({ value: true }, 31_536_000, {
      immutable: true,
    });

    expect(response.headers.get('cache-control')).toBe(
      'private, max-age=31536000, immutable'
    );
  });
});
