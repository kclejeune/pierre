import { afterEach, describe, expect, test } from 'bun:test';

import {
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
    expect(resolveAvatarCredential('viewer')).toBeUndefined();

    process.env.DIFFSHUB_AVATAR_TOKEN = '   ';
    expect(resolveAvatarCredential('viewer')).toBeUndefined();
  });

  test('lends the avatar credential to a resolved viewer', () => {
    process.env.DIFFSHUB_AVATAR_TOKEN = 'ghp_avatar';
    expect(resolveAvatarCredential('viewer')).toBe('ghp_avatar');
  });

  // The login gate passes anything merely shaped like a sealed envelope, so a
  // forged one must not unlock the deployment token.
  test('withholds it from a caller whose own credential did not resolve', () => {
    process.env.DIFFSHUB_AVATAR_TOKEN = 'ghp_avatar';
    expect(resolveAvatarCredential(undefined)).toBeUndefined();
  });

  test('reports none when it is the viewer’s own credential', () => {
    process.env.DIFFSHUB_AVATAR_TOKEN = 'same';
    expect(resolveAvatarCredential('same')).toBeUndefined();
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
    expect(resolveAvatarCredential('viewer', start)).toBe('ghp_avatar');

    noteAvatarCredentialRefused(start);

    expect(resolveAvatarCredential('viewer', start + 1)).toBeUndefined();
    expect(resolveAvatarCredential('viewer', start + 59_999)).toBeUndefined();

    // Self-healing, so a rotated credential recovers without a restart.
    expect(resolveAvatarCredential('viewer', start + 60_000)).toBe(
      'ghp_avatar'
    );
  });
});
