import { describe, expect, test } from 'bun:test';

import {
  createGitHubWebAssetProxyURL,
  matchGitHubWebAsset,
  resolveGitHubWebAssetUpstreamURL,
} from '../lib/githubWebAssets';

const GHES = 'https://ghe.company.com';

describe('matchGitHubWebAsset', () => {
  test('accepts same-instance avatars and user attachments', () => {
    expect(
      matchGitHubWebAsset(`${GHES}/avatars/u/123?s=64`, GHES)?.pathname
    ).toBe('/avatars/u/123');
    expect(
      matchGitHubWebAsset(`${GHES}/user-attachments/assets/abc-123`, GHES)
        ?.pathname
    ).toBe('/user-attachments/assets/abc-123');
  });

  test('rejects other origins, paths, and non-URLs', () => {
    expect(
      matchGitHubWebAsset('https://evil.example.com/avatars/u/1', GHES)
    ).toBeNull();
    expect(matchGitHubWebAsset(`${GHES}/owner/repo/raw/file.png`, GHES)).toBe(
      null
    );
    expect(matchGitHubWebAsset('./relative/path.png', GHES)).toBeNull();
    // Prefix look-alikes must not match: the allow-list is directory-rooted.
    expect(matchGitHubWebAsset(`${GHES}/avatarsx/u/1`, GHES)).toBeNull();
  });

  test('dotcom avatars stay direct (different origin) but attachments proxy', () => {
    const dotcom = 'https://github.com';
    expect(
      matchGitHubWebAsset('https://avatars.githubusercontent.com/u/1', dotcom)
    ).toBeNull();
    expect(
      matchGitHubWebAsset(`${dotcom}/user-attachments/assets/x`, dotcom)
    ).not.toBeNull();
  });
});

describe('createGitHubWebAssetProxyURL', () => {
  test('wraps matching URLs and preserves the query string', () => {
    expect(
      createGitHubWebAssetProxyURL(
        `${GHES}/avatars/u/123?s=64`,
        GHES,
        'octocat'
      )
    ).toBe(
      `/api/github-web-asset?url=${encodeURIComponent(`${GHES}/avatars/u/123?s=64`)}&login=octocat`
    );
    expect(
      createGitHubWebAssetProxyURL('https://cdn.example.com/x.png', GHES)
    ).toBeNull();
  });
});

describe('resolveGitHubWebAssetUpstreamURL', () => {
  const ghes = {
    apiURL: `${GHES}/api/v3`,
    isGitHubDotCom: false,
    webURL: GHES,
  };

  test('uses the GHES email avatar API with a generated no-reply address', () => {
    // GHES serves /avatars/ to session cookies only; a PAT gets a 302 to
    // /login. Its API accepts the user's generated no-reply address instead.
    const asset = matchGitHubWebAsset(`${GHES}/avatars/u/123?s=64`, GHES);
    expect(resolveGitHubWebAssetUpstreamURL(asset!, ghes, 'octocat')).toEqual({
      isAvatarLookup: true,
      url: `${GHES}/api/v3/enterprise/avatars/u/e?email=123%2Boctocat%40users.noreply.ghe.company.com&s=64`,
    });
  });

  test('keeps the enterprise prefix under subdomain isolation', () => {
    const asset = matchGitHubWebAsset(`${GHES}/avatars/u/123`, GHES);
    expect(
      resolveGitHubWebAssetUpstreamURL(
        asset!,
        {
          apiURL: 'https://api.ghe.company.com',
          isGitHubDotCom: false,
          webURL: GHES,
        },
        'octocat'
      )
    ).toEqual({
      isAvatarLookup: true,
      url: 'https://api.ghe.company.com/enterprise/avatars/u/e?email=123%2Boctocat%40users.noreply.ghe.company.com',
    });
  });

  test('forwards an avatar URL that already carries its lookup email', () => {
    // Enterprise managed users get /avatars/u/e?email= in payloads.
    const asset = matchGitHubWebAsset(
      `${GHES}/avatars/u/e?email=octocat%40example.com&s=80`,
      GHES
    );
    expect(resolveGitHubWebAssetUpstreamURL(asset!, ghes)).toEqual({
      isAvatarLookup: true,
      url: `${GHES}/api/v3/enterprise/avatars/u/e?email=octocat%40example.com&s=80`,
    });
  });

  // isAvatarLookup gates the deployment credential, so every URL left at its
  // original address must report false.
  test('leaves an avatar unchanged without the author identity', () => {
    const asset = matchGitHubWebAsset(`${GHES}/avatars/u/123`, GHES);
    expect(resolveGitHubWebAssetUpstreamURL(asset!, ghes)).toEqual({
      isAvatarLookup: false,
      url: `${GHES}/avatars/u/123`,
    });
  });

  test('leaves an org or bot avatar path unchanged', () => {
    const asset = matchGitHubWebAsset(`${GHES}/avatars/oa/12/34`, GHES);
    expect(resolveGitHubWebAssetUpstreamURL(asset!, ghes, 'octocat')).toEqual({
      isAvatarLookup: false,
      url: `${GHES}/avatars/oa/12/34`,
    });
  });

  test('leaves user attachments at their original URL', () => {
    const asset = matchGitHubWebAsset(
      `${GHES}/user-attachments/assets/abc-123`,
      GHES
    );
    expect(resolveGitHubWebAssetUpstreamURL(asset!, ghes)).toEqual({
      isAvatarLookup: false,
      url: `${GHES}/user-attachments/assets/abc-123`,
    });
  });

  test('leaves dotcom attachments untouched', () => {
    const dotcom = 'https://github.com';
    const asset = matchGitHubWebAsset(
      `${dotcom}/user-attachments/assets/x`,
      dotcom
    );
    expect(
      resolveGitHubWebAssetUpstreamURL(asset!, {
        apiURL: 'https://api.github.com',
        isGitHubDotCom: true,
        webURL: dotcom,
      })
    ).toEqual({
      isAvatarLookup: false,
      url: `${dotcom}/user-attachments/assets/x`,
    });
  });
});
