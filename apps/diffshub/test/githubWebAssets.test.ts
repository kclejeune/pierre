import { describe, expect, test } from 'bun:test';

import {
  createGitHubWebAssetProxyURL,
  matchGitHubWebAsset,
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
      createGitHubWebAssetProxyURL(`${GHES}/avatars/u/123?s=64`, GHES)
    ).toBe(
      `/api/github-web-asset?url=${encodeURIComponent(`${GHES}/avatars/u/123?s=64`)}`
    );
    expect(
      createGitHubWebAssetProxyURL('https://cdn.example.com/x.png', GHES)
    ).toBeNull();
  });
});
