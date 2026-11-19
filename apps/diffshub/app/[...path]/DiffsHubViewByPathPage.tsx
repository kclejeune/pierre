import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';

import { BrowseUI } from '@/components/BrowseUI';
import { ReviewUI } from '@/components/ReviewUI';
import { describeDiffTarget } from '@/lib/describeDiffTarget';
import { getGitHubEnvironment } from '@/lib/githubEnvironment';
import { parsePullReturnPath } from '@/lib/pullCommitsList';
import { isPullQueueId, withPullQueue } from '@/lib/pullQueue';
import { resolveDiffshubViewerRoute } from '@/lib/resolveDiffshubViewerRoute';
import { SITE_DESCRIPTION, SITE_NAME, SITE_ORIGIN } from '@/lib/site';

interface ViewByPathProps {
  params: Promise<{ path: string[] }>;
  searchParams: Promise<{
    domain?: string | string[];
    fromPull?: string | string[];
    queue?: string | string[];
  }>;
}

// The first value of a search parameter Next hands over as a string or
// an array.
function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

// The "back to the pull" link of a commit view opened from a pull. When
// that pull was opened from a /pulls list, the link keeps the list's
// ?queue=, so the pull's header still steps through it.
function returnToPullPath(
  fromPull: string | string[] | undefined,
  queue: string | string[] | undefined
): string | undefined {
  const path = parsePullReturnPath(firstParam(fromPull));
  const queueId = firstParam(queue);
  return path == null
    ? undefined
    : withPullQueue(path, isPullQueueId(queueId) ? queueId : null);
}

// Viewer pages are deliberately excluded from search results: they render
// third-party diffs fetched client-side, so there is no content of ours to
// index, and the path space is unbounded. The canonical still points at the
// normalized path so shared links with a `domain` query param collapse onto one
// URL for social previews.
export async function generateMetadata({
  params,
  searchParams,
}: ViewByPathProps): Promise<Metadata> {
  const { path } = await params;
  const { domain } = await searchParams;
  const route = resolveDiffshubViewerRoute(path, firstParam(domain));

  if (route.kind !== 'render') {
    return { title: SITE_NAME, robots: { index: false, follow: false } };
  }

  const label = describeDiffTarget(route.upstreamPath);
  const title = label == null ? SITE_NAME : `${label} — ${SITE_NAME}`;
  const description =
    label == null ? SITE_DESCRIPTION : `Viewing code changes for ${label}.`;
  const canonical = new URL(route.upstreamPath, SITE_ORIGIN).href;

  return {
    title,
    description,
    alternates: { canonical },
    robots: { index: false, follow: false },
    openGraph: {
      title,
      description,
      siteName: SITE_NAME,
      type: 'website',
      url: canonical,
      images: ['/diffshub-brand/opengraph-image.png'],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: ['/diffshub-brand/twitter-image.png'],
    },
  };
}

// Viewer route that mirrors the upstream path. GitHub is the public default,
// while hidden alternate domains can opt in through the `domain` query param.
export async function DiffsHubViewByPathPage({
  params,
  searchParams,
}: ViewByPathProps) {
  const { path } = await params;
  const { domain, fromPull, queue } = await searchParams;
  const route = resolveDiffshubViewerRoute(
    path,
    firstParam(domain),
    getGitHubEnvironment().webURL
  );

  if (route.kind === 'redirect') {
    redirect(route.target);
  }

  if (route.kind === 'not-found') {
    notFound();
  }

  if (route.kind === 'browse') {
    return (
      <BrowseUI
        owner={route.owner}
        repo={route.repo}
        view={route.view}
        refAndPath={route.refAndPath}
      />
    );
  }

  return (
    <div className="flex h-dvh flex-col gap-2">
      <ReviewUI
        domain={route.domain}
        initialUrl={route.url}
        path={route.upstreamPath}
        returnToPullPath={returnToPullPath(fromPull, queue)}
      />
    </div>
  );
}
