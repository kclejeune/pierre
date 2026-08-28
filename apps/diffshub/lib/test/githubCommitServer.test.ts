import { describe, expect, test } from 'bun:test';

import { parseGitHubErrorMessage } from '../githubCommitServer';

describe('parseGitHubErrorMessage', () => {
  test('unwraps GitHub JSON errors and preserves proxy text', () => {
    expect(
      parseGitHubErrorMessage(
        JSON.stringify({ message: 'Pull Request is not mergeable' })
      )
    ).toBe('Pull Request is not mergeable');
    expect(parseGitHubErrorMessage('upstream unavailable')).toBe(
      'upstream unavailable'
    );
  });
});
