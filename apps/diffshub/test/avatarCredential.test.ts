import { afterEach, describe, expect, test } from 'bun:test';

import {
  isAvatarCredentialRefusal,
  noteAvatarCredentialRefused,
  resetAvatarCredentialRefusal,
  resolveAvatarCredential,
} from '../lib/avatarCredential';

describe('resolveAvatarCredential', () => {
  afterEach(() => {
    delete process.env.DIFFSHUB_AVATAR_TOKEN;
    resetAvatarCredentialRefusal();
  });

  test('uses the viewer token when no avatar credential is configured', () => {
    expect(resolveAvatarCredential('viewer', true)).toBeUndefined();

    process.env.DIFFSHUB_AVATAR_TOKEN = '   ';
    expect(resolveAvatarCredential('viewer', true)).toBeUndefined();
  });

  test('lends the avatar credential to a resolved viewer', () => {
    process.env.DIFFSHUB_AVATAR_TOKEN = 'ghp_avatar';
    expect(resolveAvatarCredential('viewer', true)).toBe('ghp_avatar');
  });

  // The login gate passes anything merely shaped like a sealed envelope, so a
  // forged one must not unlock the deployment token.
  test('withholds it from a caller whose own credential did not resolve', () => {
    process.env.DIFFSHUB_AVATAR_TOKEN = 'ghp_avatar';
    expect(resolveAvatarCredential(undefined, false)).toBeUndefined();
  });

  test('withholds it from an unverified bare viewer credential', () => {
    process.env.DIFFSHUB_AVATAR_TOKEN = 'ghp_avatar';
    expect(resolveAvatarCredential('unverified', false)).toBeUndefined();
  });

  test('reports none when it is the viewer’s own credential', () => {
    process.env.DIFFSHUB_AVATAR_TOKEN = 'same';
    expect(resolveAvatarCredential('same', true)).toBeUndefined();
  });
});

describe('noteAvatarCredentialRefused', () => {
  afterEach(() => {
    delete process.env.DIFFSHUB_AVATAR_TOKEN;
    resetAvatarCredentialRefusal();
  });

  test('suppresses the credential after a refusal, then recovers', () => {
    process.env.DIFFSHUB_AVATAR_TOKEN = 'ghp_avatar';
    const start = 1_000_000;
    expect(resolveAvatarCredential('viewer', true, start)).toBe('ghp_avatar');

    noteAvatarCredentialRefused(start);

    expect(resolveAvatarCredential('viewer', true, start + 1)).toBeUndefined();
    expect(
      resolveAvatarCredential('viewer', true, start + 59_999)
    ).toBeUndefined();

    // Self-healing, so a rotated credential recovers without a restart.
    expect(resolveAvatarCredential('viewer', true, start + 60_000)).toBe(
      'ghp_avatar'
    );
  });
});

describe('isAvatarCredentialRefusal', () => {
  test('recognizes authentication failures and login pages', () => {
    expect(isAvatarCredentialRefusal(new Response('', { status: 401 }))).toBe(
      true
    );
    expect(isAvatarCredentialRefusal(new Response('', { status: 403 }))).toBe(
      true
    );
    expect(
      isAvatarCredentialRefusal(
        new Response('<html>login</html>', {
          headers: { 'Content-Type': 'text/html' },
        })
      )
    ).toBe(true);
  });

  test('treats a throttled 403 as a rate limit rather than a rejection', () => {
    // GitHub spends 403 on both "not allowed" and "too many requests"; only the
    // headers separate them, and throttling must not disable the shared token
    // for every other viewer.
    expect(
      isAvatarCredentialRefusal(
        new Response('', {
          headers: { 'x-ratelimit-remaining': '0' },
          status: 403,
        })
      )
    ).toBe(false);
    expect(
      isAvatarCredentialRefusal(
        new Response('', { headers: { 'retry-after': '60' }, status: 403 })
      )
    ).toBe(false);
    // A 403 with quota left really is a rejection.
    expect(
      isAvatarCredentialRefusal(
        new Response('', {
          headers: { 'x-ratelimit-remaining': '4999' },
          status: 403,
        })
      )
    ).toBe(true);
  });

  test('does not suppress the credential for resource or transient failures', () => {
    expect(isAvatarCredentialRefusal(new Response('', { status: 404 }))).toBe(
      false
    );
    expect(isAvatarCredentialRefusal(new Response('', { status: 429 }))).toBe(
      false
    );
    expect(isAvatarCredentialRefusal(new Response('', { status: 502 }))).toBe(
      false
    );
    expect(
      isAvatarCredentialRefusal(
        new Response('image', { headers: { 'Content-Type': 'image/png' } })
      )
    ).toBe(false);
  });
});
