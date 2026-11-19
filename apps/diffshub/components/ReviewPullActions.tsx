'use client';

import { useMemo } from 'react';

import { usePullBatch } from './PullBatchBar';
import {
  muteWithUndo,
  type PullRowAction,
  PullRowActions,
} from './PullRowActions';
import { useMutedAuthors } from './useMutedAuthors';
import { pullSummaryFromDetails } from '@/lib/githubPullSummaries';
import {
  authorSearchName,
  isAuthorMuted,
  MAX_MUTED_AUTHORS,
} from '@/lib/mutedAuthors';
import type { PullRequestRef } from '@/lib/pullCommentsClient';
import type { PullDetails } from '@/lib/pullInfoClient';

// The review page's copy of the /pulls row actions (components/
// PullRowActions), in the header's PR segment: quick approve and merge when
// ready (one-pull batches, as on the list), copying the pull's links, and
// muting its author. Approve and merge are pinned to `headSha`, the commit
// the diff on screen shows, so a push after the page loaded fails them
// rather than approving or merging commits the viewer hasn't seen; until
// that head is known they stay disabled. A merge reloads the page's diff
// through `onMerged`, like the details panel's merge footer, and an approval
// refreshes the conversation through `onApproved`.
export function ReviewPullActions({
  className,
  details,
  headSha,
  onApproved,
  onMerged,
  pullRequest,
}: {
  className?: string;
  details: PullDetails;
  headSha: string | undefined;
  onApproved(): void;
  onMerged(): void;
  pullRequest: PullRequestRef;
}) {
  const { mute, muted, unmute } = useMutedAuthors();
  const batch = usePullBatch(({ action, changed }) => {
    if (!changed) {
      return;
    }
    if (action === 'merge') {
      onMerged();
    } else {
      onApproved();
    }
  });
  const pull = useMemo(
    () => pullSummaryFromDetails(pullRequest, details),
    [details, pullRequest]
  );
  const author = authorSearchName(pull);
  const authorMuted = author != null && isAuthorMuted(muted, author);
  const onAction = (target: typeof pull, action: PullRowAction) => {
    if ((action === 'approve' || action === 'merge') && headSha != null) {
      batch.run(action, [target], 'row', headSha);
    } else if (author != null && action === 'unmute') {
      unmute(author);
    } else if (author != null && action === 'mute') {
      muteWithUndo(author, mute, unmute);
    }
  };
  return (
    <PullRowActions
      authorMuted={authorMuted}
      busy={batch.running != null || headSha == null}
      className={className}
      muteFull={muted.length >= MAX_MUTED_AUTHORS}
      pull={pull}
      variant="header"
      onAction={onAction}
    />
  );
}
