import { describe, expect, test } from 'bun:test';

import { getUnreadableCopy } from '../app/pulls/PullsDashboard';

// An empty /pulls list whose search matched pulls the GitHub App can't read.
describe('getUnreadableCopy', () => {
  test('a fully scanned search blames the whole result set', () => {
    expect(getUnreadableCopy(51, false)).toStartWith(
      "51 pull requests match, but the DiffsHub GitHub App can't read"
    );
    expect(getUnreadableCopy(1, false)).toStartWith('1 pull request matches');
  });

  // The route's skip budget can run out with pages left; a readable pull may
  // still follow, so the copy must not claim every match is unreadable.
  test('a partly scanned search only describes the pages checked', () => {
    const copy = getUnreadableCopy(51, true);
    expect(copy).toContain('checked so far');
    expect(copy).toContain('Load more');
    expect(copy).not.toContain('51');
    expect(copy).not.toContain('organization owner');
  });
});
