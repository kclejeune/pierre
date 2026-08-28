import { describe, expect, test } from 'bun:test';

import { unwrapRefreshToken, wrapRefreshToken } from '@/lib/refreshTokenWrap';

const SECRET = 'oauth-client-secret';
const WRAPPED = await wrapRefreshToken('ghr_refresh', 1_700_000_000, SECRET);

describe('refresh token wrapping', () => {
  test('round-trips the token and authorization time', async () => {
    expect(WRAPPED.startsWith('dhr1.')).toBe(true);
    expect(await unwrapRefreshToken(WRAPPED, SECRET)).toEqual({
      issuedAt: 1_700_000_000,
      refreshToken: 'ghr_refresh',
    });
  });

  test('rejects a tampered payload', async () => {
    const [prefix, , mac] = WRAPPED.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ rt: 'ghr_refresh', iat: 1 })
    ).toString('base64url');
    expect(
      await unwrapRefreshToken(`${prefix}.${forgedPayload}.${mac}`, SECRET)
    ).toBeUndefined();
  });

  test('rejects a token wrapped under a different secret', async () => {
    const wrapped = await wrapRefreshToken('ghr_refresh', 1_700_000_000, 'old');
    expect(await unwrapRefreshToken(wrapped, SECRET)).toBeUndefined();
  });

  test('rejects bare GitHub tokens and garbage', async () => {
    expect(await unwrapRefreshToken('ghr_bare_token', SECRET)).toBeUndefined();
    expect(await unwrapRefreshToken('', SECRET)).toBeUndefined();
    expect(await unwrapRefreshToken('dhr1.!!.!!', SECRET)).toBeUndefined();
  });
});
