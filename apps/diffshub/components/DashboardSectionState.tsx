'use client';

import type { ReactNode } from 'react';

import { Button } from './Button';
import { useGitHubEnvironment } from './GitHubEnvironmentProvider';
import { startGitHubSignIn } from './GitHubTokenControl';
import { cn } from '@/lib/cn';
import { APIRequestError } from '@/lib/pullCommentsClient';

// Loading placeholders sized like the real rows so the swap doesn't shift the
// page.
export function SkeletonRows({
  count = 3,
  variant,
}: {
  count?: number;
  variant: 'list' | 'pull';
}) {
  return (
    <div aria-hidden className="animate-pulse motion-reduce:animate-none">
      {Array.from({ length: count }, (_, index) =>
        variant === 'pull' ? (
          <div
            key={index}
            className="flex items-center gap-3 border-b p-3 last:border-b-0"
          >
            <span className="bg-muted size-4 shrink-0 rounded-full" />
            <span className="flex h-9 min-w-0 flex-1 flex-col justify-center gap-2">
              <span className="bg-muted h-3 w-3/5 rounded-sm" />
              <span className="bg-muted h-2.5 w-1/4 rounded-sm" />
            </span>
            <span className="bg-muted size-6 shrink-0 rounded-full" />
          </div>
        ) : (
          <div
            key={index}
            className="flex h-8 items-center border-b px-3 last:border-b-0"
          >
            <span className="bg-muted h-3 w-2/5 rounded-sm" />
          </div>
        )
      )}
    </div>
  );
}

// A muted or error line with an optional Retry.
export function SectionMessage({
  children,
  onRetry,
  tone = 'muted',
}: {
  children: ReactNode;
  onRetry?(): void;
  tone?: 'error' | 'muted';
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      className="flex items-center justify-between gap-3 p-3"
    >
      <p
        className={cn(
          'text-sm',
          tone === 'error' ? 'text-destructive' : 'text-muted-foreground'
        )}
      >
        {children}
      </p>
      {onRetry != null && (
        <Button variant="outline" size="xs" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

// A failed request. Retrying can't fix a 401, so it offers sign-in instead
// where OAuth is available.
export function SectionError({
  error,
  onRetry,
}: {
  error: Error;
  onRetry?(): void;
}) {
  const { oauthEnabled } = useGitHubEnvironment();
  if (!(error instanceof APIRequestError && error.status === 401)) {
    return (
      <SectionMessage tone="error" onRetry={onRetry}>
        {error.message}
      </SectionMessage>
    );
  }
  return (
    <div role="alert" className="flex items-center justify-between gap-3 p-3">
      <p className="text-destructive text-sm">
        {oauthEnabled
          ? 'Your GitHub sign-in has expired. Sign in again to load this.'
          : 'Your saved GitHub token no longer works. Replace it from the GitHub menu at the top right.'}
      </p>
      {oauthEnabled && (
        <Button variant="outline" size="xs" onClick={startGitHubSignIn}>
          Sign in again
        </Button>
      )}
    </div>
  );
}

interface DashboardSectionStateProps {
  children?: ReactNode;
  // Optional for sections that never render empty.
  emptyLabel?: ReactNode;
  error: Error | null;
  isEmpty: boolean;
  // Skeleton on first load only; reloads keep existing rows.
  loading: boolean;
  // Screen-reader text for the skeleton.
  loadingLabel: string;
  onRetry?(): void;
  skeleton: ReactNode;
}

// Shared loading/error/empty/content switch. Errors after rows have loaded
// render below them.
export function DashboardSectionState({
  children,
  emptyLabel,
  error,
  isEmpty,
  loading,
  loadingLabel,
  onRetry,
  skeleton,
}: DashboardSectionStateProps) {
  if (isEmpty && loading) {
    return (
      <div role="status">
        <span className="sr-only">{loadingLabel}</span>
        {skeleton}
      </div>
    );
  }
  const errorMessage =
    error == null ? null : <SectionError error={error} onRetry={onRetry} />;
  if (isEmpty) {
    return errorMessage ?? <SectionMessage>{emptyLabel}</SectionMessage>;
  }
  return (
    <>
      {children}
      {errorMessage}
    </>
  );
}
