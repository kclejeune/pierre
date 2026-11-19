import { describe, expect, test } from 'bun:test';

import { PULL_STATUS_CHUNK_SIZE } from '@/lib/githubPullSummaries';
import { PROFILED_STATUS_CHUNK_SIZES } from '@/lib/pullsSearchProfile';

describe('pullsSearchProfile', () => {
  test('the profiled chunk sizes include the one the route uses', () => {
    expect(PROFILED_STATUS_CHUNK_SIZES).toContain(PULL_STATUS_CHUNK_SIZE);
  });
});
