import { type NextRequest } from 'next/server';
import { createHash } from 'node:crypto';

import { createJSONResponse } from '@/lib/jsonResponse';
import { parseJSONBody } from '@/lib/parseJSONBody';
import {
  type PreferenceContext,
  withPreferenceContext,
} from '@/lib/preferenceRoute';
import { withRequestLog } from '@/lib/requestLog';
import {
  isValidReviewedSource,
  MAX_REVIEWED_SOURCE_LENGTH,
  parseReviewedFiles,
  parseStoredReviewedFiles,
} from '@/lib/reviewedFilesPayload';

// Per-user reviewed-file marks for one diff source (a PR, commit, or patch
// URL), persisted beside the preference map so "Viewed" checkboxes follow a
// viewer across browsers.
//
//   GET ?source=…                    → { enabled, files: { path: fp } | null }
//   PUT { source, files: { path: fp } } → { enabled }
//
// `files: null` means nothing is stored for that source yet. A PUT replaces
// the source's whole map, so concurrent writers are last-write-wins. Each
// source is its own store key that expires REVIEWED_TTL_SECONDS after its
// last write, which bounds storage for PRs nobody revisits. The client only
// writes after a change, so there is no read-before-write no-op check here.

const REVIEWED_TTL_SECONDS = 90 * 24 * 60 * 60;

// The source is hashed so arbitrary URLs and paths make fixed-size keys.
function storageKey({ viewerScope }: PreferenceContext, source: string) {
  const digest = createHash('sha256').update(source).digest('hex');
  return `diffshub:reviewed:v1:${viewerScope}:${digest}`;
}

function invalidSource(): Response {
  return createJSONResponse(
    {
      error: `Expected a diff source of 1-${MAX_REVIEWED_SOURCE_LENGTH} characters.`,
    },
    { status: 400 }
  );
}

async function handleGET(context: PreferenceContext, request: NextRequest) {
  const source = request.nextUrl.searchParams.get('source');
  if (!isValidReviewedSource(source)) {
    return invalidSource();
  }
  return createJSONResponse({
    enabled: true,
    files: parseStoredReviewedFiles(
      await context.store.get(storageKey(context, source))
    ),
  });
}

async function handlePUT(context: PreferenceContext, request: NextRequest) {
  const body = await parseJSONBody(request);
  if (!isValidReviewedSource(body?.source)) {
    return invalidSource();
  }
  const parsed = parseReviewedFiles(body.files, context.credentials);
  if (parsed.error != null) {
    return createJSONResponse({ error: parsed.error }, { status: 400 });
  }
  await context.store.put(storageKey(context, body.source), parsed.serialized, {
    expirationTtl: REVIEWED_TTL_SECONDS,
  });
  return createJSONResponse({ enabled: true });
}

export const GET = withRequestLog(
  withPreferenceContext(handleGET, { files: null })
);
export const PUT = withRequestLog(withPreferenceContext(handlePUT));
