import { describe, expect, test } from 'bun:test';

import { buildActiveSearchQuery } from '@/lib/githubPullSummaries';
import {
  audienceAnyoneAllowed,
  readPullsPageState,
  resolveAudience,
  writePullsPageState,
} from '@/lib/pullScopes';
import {
  readPullSort,
  readPullStateFilter,
  splitPullSort,
  tokenizePullQuery,
  writePullSort,
  writePullStateFilter,
} from '@/lib/pullSearchQuery';

describe('tokenizePullQuery', () => {
  test('reproduces the input exactly, for the highlighter', () => {
    const text = '  is:open -label:"good first issue" (a OR b)  fix ';
    expect(
      tokenizePullQuery(text)
        .map((token) => token.raw)
        .join('')
    ).toBe(text);
  });

  test('classifies qualifiers, negation, operators, and text', () => {
    const tokens = tokenizePullQuery('-label:"a b" OR author:@me crash').filter(
      (token) => token.kind !== 'space'
    );
    expect(tokens).toEqual([
      {
        kind: 'qualifier',
        raw: '-label:"a b"',
        key: 'label',
        negated: true,
        value: '"a b"',
      },
      { kind: 'operator', raw: 'OR' },
      {
        kind: 'qualifier',
        raw: 'author:@me',
        key: 'author',
        negated: false,
        value: '@me',
      },
      { kind: 'text', raw: 'crash' },
    ]);
  });
});

describe('state and sort edits', () => {
  test('the state toggle rewrites only state qualifiers', () => {
    expect(readPullStateFilter('is:open label:bug')).toBe('open');
    expect(readPullStateFilter('label:bug')).toBe('all');
    expect(readPullStateFilter('state:closed')).toBe('closed');
    expect(writePullStateFilter('is:open is:draft label:bug', 'merged')).toBe(
      'is:draft label:bug is:merged'
    );
    expect(writePullStateFilter('is:open label:bug', 'all')).toBe('label:bug');
    // Negated state terms are the user's own filter, not the toggle's.
    expect(writePullStateFilter('-is:merged', 'closed')).toBe(
      '-is:merged is:closed'
    );
  });

  // Removing an operand takes the boolean structure it leaves dangling with
  // it, so the toggle never writes an invalid search.
  test('the state toggle keeps boolean searches valid', () => {
    const cases: [string, string][] = [
      ['is:open OR is:merged', 'is:closed'],
      ['is:open AND label:bug', 'label:bug is:closed'],
      ['(is:open OR is:merged) label:bug', 'label:bug is:closed'],
      ['label:bug NOT is:open', 'label:bug is:closed'],
      // The NOT goes with the operand it negated, not onto label:x.
      ['label:bug NOT is:open label:x', 'label:bug label:x is:closed'],
      ['NOT (is:open) label:x', 'label:x is:closed'],
      // One OR survives, and the new state applies to the whole OR.
      ['a OR is:open OR b', '(a OR b) is:closed'],
      ['a OR (b AND is:open)', '(a OR (b)) is:closed'],
    ];
    for (const [input, expected] of cases) {
      expect(writePullStateFilter(input, 'closed')).toBe(expected);
    }
    expect(writePullStateFilter('is:open OR is:merged', 'all')).toBe('');
  });

  // A grouped OR is already scoped, so repeated toggles must not keep
  // wrapping it (GitHub rejects more than five levels of nesting).
  test('state toggles do not re-wrap an already grouped OR', () => {
    let text = 'is:open (label:bug OR label:enhancement)';
    for (const state of ['closed', 'merged', 'open', 'closed'] as const) {
      text = writePullStateFilter(text, state);
    }
    expect(text).toBe('(label:bug OR label:enhancement) is:closed');
    expect(
      writePullStateFilter('is:open label:bug OR label:enhancement', 'closed')
    ).toBe('(label:bug OR label:enhancement) is:closed');
    expect(
      writePullStateFilter(
        '(label:bug OR label:enhancement) is:closed',
        'merged'
      )
    ).toBe('(label:bug OR label:enhancement) is:merged');
  });

  test('the sort menu rewrites sort: and splits it out for the server', () => {
    expect(readPullSort('is:open')).toBe('');
    expect(writePullSort('is:open', 'created-asc')).toBe(
      'is:open sort:created-asc'
    );
    expect(writePullSort('sort:created-asc is:open', '')).toBe('is:open');
    expect(splitPullSort('is:open sort:comments-desc label:x')).toEqual({
      rest: 'is:open label:x',
      sort: 'comments-desc',
    });
  });

  test('edits keep quoted values whole', () => {
    expect(writePullSort('label:"needs  review" is:open', 'created-asc')).toBe(
      'label:"needs  review" is:open sort:created-asc'
    );
  });
});

describe('pulls page URL state', () => {
  test('defaults stay out of the URL', () => {
    const url = writePullsPageState(new URL('https://x.test/pulls'), {
      involves: [],
      reviewRequests: 'direct',
      scope: { kind: 'all' },
      text: 'is:open',
    });
    expect(url.search).toBe('');
    const repoUrl = writePullsPageState(new URL('https://x.test/pulls'), {
      involves: 'anyone',
      reviewRequests: 'direct',
      scope: { kind: 'repo', repo: 'oven-sh/bun' },
      text: 'is:open',
    });
    expect(repoUrl.search).toBe('?repo=oven-sh%2Fbun');
  });

  test('round-trips non-default state', () => {
    const state = {
      involves: [] as const,
      reviewRequests: 'teams' as const,
      scope: { kind: 'repo', repo: 'oven-sh/bun' } as const,
      text: 'is:merged label:bug',
    };
    const url = writePullsPageState(new URL('https://x.test/pulls'), state);
    expect(url.searchParams.get('involves')).toBe('me');
    expect(url.searchParams.get('requests')).toBe('teams');
    expect(readPullsPageState(url.search)).toEqual(state);
  });

  test('maps legacy ?bucket= links onto involvement chips', () => {
    expect(readPullsPageState('?bucket=created')).toEqual({
      involves: ['authored'],
      reviewRequests: 'direct',
      scope: { kind: 'all' },
      text: 'is:open',
    });
    expect(readPullsPageState('?bucket=toString').involves).toEqual([]);
  });

  test('anyone needs repositories to narrow it', () => {
    expect(audienceAnyoneAllowed({ kind: 'all' }, 'is:open')).toBe(false);
    expect(audienceAnyoneAllowed({ kind: 'all' }, 'is:open org:oven-sh')).toBe(
      true
    );
    expect(audienceAnyoneAllowed({ kind: 'pinned' }, '')).toBe(true);
    // A negated or quoted repo term doesn't narrow anything.
    expect(audienceAnyoneAllowed({ kind: 'all' }, '-repo:oven-sh/bun')).toBe(
      false
    );
    expect(audienceAnyoneAllowed({ kind: 'all' }, '"repo:x"')).toBe(false);
  });

  // The repository term has to bind every result, so OR branches and NOT
  // are part of the check.
  test('anyone reads the boolean structure around repository terms', () => {
    const allowed = (text: string) =>
      audienceAnyoneAllowed({ kind: 'all' }, text);
    expect(allowed('repo:a/b OR is:open')).toBe(false);
    expect(allowed('is:open NOT org:acme')).toBe(false);
    expect(allowed('NOT (org:acme)')).toBe(false);
    expect(allowed('-(org:acme label:x)')).toBe(false);
    expect(allowed('(repo:a/b OR is:open) label:x')).toBe(false);
    expect(allowed('repo:a/b OR repo:c/d')).toBe(true);
    expect(allowed('(repo:a/b OR org:acme) is:open')).toBe(true);
    expect(allowed('is:open AND org:acme')).toBe(true);
    expect(allowed('org:acme NOT label:x')).toBe(true);
    expect(allowed('(org:acme is:open) OR (repo:a/b label:x)')).toBe(true);
    // Unbalanced parens have no reliable reading.
    expect(allowed('(org:acme')).toBe(false);
    expect(allowed('org:acme)')).toBe(false);
  });

  test('anyone narrows to involves me where it is not allowed', () => {
    const base = {
      involves: 'anyone' as const,
      reviewRequests: 'direct' as const,
      text: 'is:open',
    };
    expect(resolveAudience({ ...base, scope: { kind: 'all' } })).toEqual([]);
    expect(resolveAudience({ ...base, scope: { kind: 'pinned' } })).toBe(
      'anyone'
    );
  });
});

describe('search builder reads the typed text with the tokenizer', () => {
  test('OR and archived: inside quoted values are just text', () => {
    expect(
      buildActiveSearchQuery({
        involves: 'anyone',
        repos: ['oven-sh/bun'],
        text: 'label:"A OR B" "archived:true"',
      })
    ).toBe(
      'label:"A OR B" "archived:true" is:pr archived:false repo:oven-sh/bun'
    );
  });

  test('an already grouped OR is not wrapped again', () => {
    expect(
      buildActiveSearchQuery({
        involves: 'anyone',
        repos: ['oven-sh/bun'],
        text: '(label:a OR label:b) is:open',
      })
    ).toBe(
      '(label:a OR label:b) is:open is:pr archived:false repo:oven-sh/bun'
    );
  });
});
