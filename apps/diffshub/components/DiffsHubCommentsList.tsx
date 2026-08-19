'use client';

import type { AnnotationSide } from '@pierre/diffs';
import { IconArrowUpRight, IconConvoFill, IconPlus } from '@pierre/icons';
import {
  createContext,
  type HTMLAttributes,
  memo,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import { CommentComposer } from './CommentComposer';
import {
  CommentDeleteConfirm,
  CommentEditComposer,
  CommentModerationButtons,
  useCommentModeration,
} from './CommentModeration';
import { MarkdownContent, RawMarkdownFallback } from './MarkdownContent';
import { useGitHubUser } from './useGitHubUser';
import { cn } from '@/lib/cn';
import { createCommentSidebarPreview } from '@/lib/commentSidebarPreview';
import { formatRelativeTime } from '@/lib/formatRelativeTime';
import type {
  CommentLineType,
  DiffsHubSavedCommentEntry,
  DiffsHubSavedCommentItem,
  PullDiscussionComment,
} from '@/lib/types';

// Card chrome shared by the sidebar's stacked card sections. The border and
// surface come from themed CSS variables (set on the sidebar wrapper) so
// cards stay on-palette for mixed-light/dark themes like slack-ochin
// (light-typed but uses a dark navy sidebar); the hardcoded fallbacks cover
// the brief window before the Shiki theme resolves on first render.
const CARD_BORDER_CLASS =
  'border-[var(--diffshub-card-border,rgb(0_0_0_/_0.1))] dark:border-[var(--diffshub-card-border,rgb(255_255_255_/_0.15))]';

// A row inside a card stack: hairline separators between rows, with the
// stack's outer rounding echoed on the first/last rows.
const CARD_ROW_CLASS = cn(
  CARD_BORDER_CLASS,
  'border-b bg-[var(--diffshub-card-bg,var(--color-card))] first:rounded-t-lg last:rounded-b-lg last:border-b-0'
);

// Comment bodies in sidebar rows render as markdown at the row's 14px size,
// with the prose spacing tightened so a one-line comment stays one line.
const SIDEBAR_MARKDOWN_CLASS =
  'text-foreground w-full text-[14px] leading-normal [&_p]:my-0! [&_p+p]:mt-2! [&_pre]:my-1.5! [&_ul]:my-1! [&_ol]:my-1! [&_blockquote]:my-1! [&_img]:max-h-40 [&_h1]:text-[1.15em]! [&_h2]:text-[1.1em]! [&_h3]:text-[1em]! [&_:is(h1,h2,h3)]:my-1.5!';

// Rows that are not expanded clamp the rendered body to a few lines so long
// descriptions do not swallow the list while the formatting still reads at a
// glance. `-webkit-line-clamp` counts lines across the nested markdown blocks,
// so paragraphs, lists, and code all clamp together. Merged once here so the
// per-row `className` stays referentially stable across list re-renders.
const COLLAPSED_SIDEBAR_MARKDOWN_CLASS = cn(
  SIDEBAR_MARKDOWN_CLASS,
  'line-clamp-6'
);

// Visibility tracking for the sidebar rows, shared through context so the
// list owns one IntersectionObserver rooted at its own scroll container.
// The root must be the scroller, not the viewport: rows outside the
// scroller's box are clipped by it regardless of any viewport margin, so a
// viewport-rooted observer could not pre-render rows before they scroll in.
// The default (no list above) reports every row visible immediately.
type ObserveRow = (element: Element, onVisible: () => void) => () => void;
const RowVisibilityContext = createContext<ObserveRow>((_, onVisible) => {
  onVisible();
  return () => {};
});

// Creates the observer lazily on first use — child effects run before the
// parent's, but the scroller ref is already attached by then — and tears
// it down with the list. The generous margin renders rows well before they
// come into view, so the plain-text → markdown swap happens off-screen.
function useRowVisibilityObserver(
  scrollerRef: RefObject<HTMLDivElement | null>
): ObserveRow {
  const observerRef = useRef<{
    callbacks: WeakMap<Element, () => void>;
    observer: IntersectionObserver;
  } | null>(null);
  useEffect(
    () => () => {
      observerRef.current?.observer.disconnect();
      observerRef.current = null;
    },
    []
  );
  return useCallback(
    (element, onVisible) => {
      if (observerRef.current == null) {
        const callbacks = new WeakMap<Element, () => void>();
        const observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) {
                callbacks.get(entry.target)?.();
              }
            }
          },
          { root: scrollerRef.current, rootMargin: '1000px 0px' }
        );
        observerRef.current = { callbacks, observer };
      }
      const { callbacks, observer } = observerRef.current;
      callbacks.set(element, onVisible);
      observer.observe(element);
      return () => {
        callbacks.delete(element);
        observer.unobserve(element);
      };
    },
    [scrollerRef]
  );
}

// Renders a comment body as markdown once its row nears the viewport, and as
// plain text until then. Parsing markdown for every row up front costs
// seconds of main-thread time on pulls with a thousand comments, almost all
// of them never scrolled to; the deferral keeps the tab switch instant while
// every row the user actually sees is rendered. Once rendered, a row stays
// rendered (its subtree is memoized) so scrolling back never re-parses.
function DeferredMarkdown({
  className,
  markdown,
}: {
  className?: string;
  markdown: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const observeRow = useContext(RowVisibilityContext);
  const [rendered, setRendered] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (rendered || element == null) {
      return;
    }
    return observeRow(element, () => setRendered(true));
  }, [observeRow, rendered]);
  if (rendered) {
    return <MarkdownContent className={className} markdown={markdown} />;
  }
  return (
    <RawMarkdownFallback ref={ref} className={className} markdown={markdown} />
  );
}

// Write access to the PR-level conversation, provided only on pull-request
// views. `canWrite` mirrors the thread cards' meaning: a token is saved, so
// writes can be attempted at all. Edit/delete only apply to issue comments
// (kind 'comment'); review summaries are read-only.
export interface DiscussionActions {
  canWrite: boolean;
  onDelete(commentId: number): Promise<void>;
  onEdit(commentId: number, body: string): Promise<void>;
  onPost(body: string): Promise<void>;
}

interface DiffsHubCommentsListProps {
  commentSections: readonly DiffsHubSavedCommentItem[];
  // PR-level conversation (issue comments, review summaries) shown in its own
  // section above the per-file threads.
  discussion?: readonly PullDiscussionComment[];
  discussionActions?: DiscussionActions;
  onSelectComment?(comment: DiffsHubSavedCommentEntry): void;
  onSelectItem?(itemId: string): void;
}

// The action phrase after a discussion row's @handle. Review verdicts get
// their own wording (and, below, the add/del accent colors) so approvals and
// change requests read at a glance.
function getDiscussionVerb(comment: PullDiscussionComment): string {
  if (comment.kind === 'comment') {
    return 'commented';
  }
  switch (comment.reviewState) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'requested changes';
    case 'DISMISSED':
      return 'reviewed (dismissed)';
    default:
      return 'reviewed';
  }
}

function getDiscussionVerbClassName(
  comment: PullDiscussionComment
): string | null {
  switch (comment.reviewState) {
    case 'APPROVED':
      return 'text-[var(--diffshub-comment-add-fg,#047857)] dark:text-[var(--diffshub-comment-add-fg,#34d399)] font-medium';
    case 'CHANGES_REQUESTED':
      return 'text-[var(--diffshub-comment-del-fg,#be123c)] dark:text-[var(--diffshub-comment-del-fg,#fb7185)] font-medium';
    default:
      return null;
  }
}

function getCommentLineLabel(
  side: AnnotationSide,
  lineNumber: number,
  lineType: CommentLineType
): string {
  if (lineType === 'context') {
    return `Line ${lineNumber}`;
  }
  const sigil = side === 'additions' ? '+' : '-';
  return `Line ${sigil}${lineNumber}`;
}

function getCommentLineClassName(
  side: AnnotationSide,
  lineType: CommentLineType
): string {
  if (lineType === 'context') {
    return 'text-muted-foreground';
  }
  // The themed chrome sets --diffshub-comment-add-fg / -del-fg with a shade
  // chosen from the active Shiki surface's luminance, so addition/deletion
  // labels stay legible even on mixed-palette themes (e.g. slack-ochin's
  // "light" classification with a dark navy sidebar, where the global
  // `dark:` variant would otherwise leave us with low-contrast 700 shades
  // on a dark card). The Tailwind shades stay as fallbacks for the
  // first-render window before the chrome style applies.
  return side === 'additions'
    ? 'text-[var(--diffshub-comment-add-fg,#047857)] dark:text-[var(--diffshub-comment-add-fg,#34d399)]'
    : 'text-[var(--diffshub-comment-del-fg,#be123c)] dark:text-[var(--diffshub-comment-del-fg,#fb7185)]';
}

// Wraps a click handler so users can drag-select text inside the row without
// also triggering navigation. mouseup after a selection fires click on the
// button; bail out only when the resulting selection is anchored inside this
// row, so a pre-existing selection elsewhere on the page (e.g. in the diff
// viewer) does not block keyboard/mouse activation of the row.
function handleRowClick(event: MouseEvent<HTMLElement>, run: () => void): void {
  if (event.button !== 0) {
    return;
  }
  const selection =
    typeof window !== 'undefined' ? window.getSelection() : null;
  if (selection != null && selection.toString().length > 0) {
    const row = event.currentTarget;
    const anchorInRow =
      selection.anchorNode != null && row.contains(selection.anchorNode);
    const focusInRow =
      selection.focusNode != null && row.contains(selection.focusNode);
    if (anchorInRow || focusInRow) {
      event.preventDefault();
      return;
    }
  }
  run();
}

// A clickable card row whose body may contain its own interactive content
// (markdown links, moderation buttons, an edit composer). A real <button>
// cannot legally contain those, so the row is a div with button semantics:
// clicks on interactive descendants are theirs, everything else — and
// Enter/Space on the row itself — activates the row.
function CommentRow({
  children,
  className,
  onActivate,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  onActivate(): void;
} & Omit<HTMLAttributes<HTMLDivElement>, 'onClick' | 'onKeyDown'>) {
  return (
    <div
      role="button"
      tabIndex={0}
      {...rest}
      // No `transition-colors` here: the bg / border / text colors are
      // driven by CSS variables that flip the entire chrome on every theme
      // swap, so a smooth color transition on each card visibly trails the
      // rest of the UI (header, file tree, diff body) which snap instantly.
      className={cn(
        CARD_ROW_CLASS,
        'focus-visible:ring-ring flex w-full cursor-pointer items-start gap-2 p-3 text-left text-sm outline-none hover:bg-[var(--diffshub-card-hover-bg,var(--color-muted))] focus-visible:ring-2',
        className
      )}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (
          target !== event.currentTarget &&
          target.closest('a, button, form') != null
        ) {
          return;
        }
        handleRowClick(event, onActivate);
      }}
      onKeyDown={(event) => {
        if (
          (event.key === 'Enter' || event.key === ' ') &&
          event.target === event.currentTarget
        ) {
          event.preventDefault();
          onActivate();
        }
      }}
    >
      {children}
    </div>
  );
}

// A PR-level conversation entry. There is no diff anchor to scroll to, so the
// row's default click expands the body in place — collapsed rows clamp the
// rendered markdown to a few lines, expanded rows show all of it — so
// reading the comment stays in-app. The upstream GitHub permalink is an
// explicit arrow affordance, matching the embedded thread cards, rather than
// the whole-row default. Signed-in authors get edit/delete on their own
// conversation comments (never on review summaries — see DiscussionActions).
function DiscussionRow({
  actions,
  comment,
}: {
  actions?: DiscussionActions;
  comment: PullDiscussionComment;
}) {
  const [expanded, setExpanded] = useState(false);
  const moderation = useCommentModeration(async () => {
    await actions?.onDelete(comment.id);
  });
  const githubUser = useGitHubUser();
  const canModify =
    actions != null &&
    actions.canWrite &&
    comment.kind === 'comment' &&
    githubUser?.login === comment.author.login;
  const preview = createCommentSidebarPreview(comment.body);

  const toggleExpanded = () => {
    if (!moderation.isEditing && !moderation.isConfirmingDelete) {
      setExpanded((prev) => !prev);
    }
  };

  return (
    <CommentRow
      aria-expanded={expanded}
      className="group/discussion"
      onActivate={toggleExpanded}
    >
      <CommentAuthorAvatar author={comment.author} className="size-5" />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5 select-text">
        <div className="text-muted-foreground flex w-full flex-wrap items-center gap-x-1">
          <span className="text-foreground font-medium">
            @{comment.author.login}
          </span>
          <span className={cn(getDiscussionVerbClassName(comment))}>
            {getDiscussionVerb(comment)}
          </span>
          <span>· {formatRelativeTime(comment.createdAt)}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {canModify && !moderation.isEditing && (
              <span className="flex gap-1 opacity-0 transition-opacity duration-100 group-focus-within/discussion:opacity-100 group-hover/discussion:opacity-100">
                <CommentModerationButtons
                  moderation={moderation}
                  onBeginEdit={() => setExpanded(true)}
                />
              </span>
            )}
            {comment.htmlUrl != null && (
              <a
                className="hover:text-foreground"
                aria-label="Open comment on GitHub"
                title="Open comment on GitHub"
                href={comment.htmlUrl}
                rel="noreferrer noopener"
                target="_blank"
              >
                <IconArrowUpRight size={14} />
              </a>
            )}
          </span>
        </div>
        {moderation.isEditing && actions != null ? (
          <div className="w-full pt-1">
            <CommentEditComposer
              initialBody={comment.body}
              moderation={moderation}
              onEdit={(body) => actions.onEdit(comment.id, body)}
            />
          </div>
        ) : (
          preview !== '' && (
            <DeferredMarkdown
              className={
                expanded
                  ? SIDEBAR_MARKDOWN_CLASS
                  : COLLAPSED_SIDEBAR_MARKDOWN_CLASS
              }
              markdown={preview}
            />
          )
        )}
        {moderation.isConfirmingDelete && actions != null && (
          <div className="w-full pt-1">
            <CommentDeleteConfirm moderation={moderation} />
          </div>
        )}
      </div>
    </CommentRow>
  );
}

// The Conversation section's trailing row: opens a composer that posts a new
// PR-level comment. Anonymous sessions get the same sign-in nudge as thread
// replies instead of a composer they could not submit.
function DiscussionComposerRow({ actions }: { actions: DiscussionActions }) {
  const [isOpen, setIsOpen] = useState(false);

  if (!actions.canWrite) {
    return (
      <div
        className={cn(CARD_ROW_CLASS, 'text-muted-foreground p-3 text-[13px]')}
      >
        Sign in with GitHub or save a token to comment.
      </div>
    );
  }

  return (
    <div className={cn(CARD_ROW_CLASS, 'p-3')}>
      {isOpen ? (
        <CommentComposer
          autoFocus
          submitLabel="Comment"
          onCancel={() => setIsOpen(false)}
          onSubmit={async (body) => {
            await actions.onPost(body);
            setIsOpen(false);
          }}
        />
      ) : (
        <button
          type="button"
          className="text-muted-foreground hover:border-foreground/30 hover:text-foreground w-full cursor-text rounded-md border border-[var(--diffshub-card-border,var(--color-border))] px-3 py-1.5 text-left text-[13px] transition-colors"
          onClick={() => setIsOpen(true)}
        >
          Add a comment…
        </button>
      )}
    </div>
  );
}

export const DiffsHubCommentsList = memo(function DiffsHubCommentsList({
  commentSections,
  discussion = [],
  discussionActions,
  onSelectComment,
  onSelectItem,
}: DiffsHubCommentsListProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const observeRow = useRowVisibilityObserver(scrollerRef);
  // On pull-request views the Conversation section always renders (its
  // composer is how PR-level comments get written), so the empty state only
  // applies when there is nothing to show AND nothing to write.
  const showConversation = discussion.length > 0 || discussionActions != null;
  if (commentSections.length === 0 && !showConversation) {
    return (
      <div className="text-muted-foreground flex h-full min-h-0 flex-col items-center justify-center gap-2 px-7 text-center text-sm">
        <IconConvoFill size={24} className="mb-2" />
        <div className="flex flex-col">
          <strong className="font-medium">No comments yet</strong>
          <p>
            Hover over a line and click the{' '}
            <span className="light:text-white light:bg-[rgb(0,159,255)] inline-flex h-[20px] w-[20px] items-center justify-center rounded-[4px] align-top dark:bg-[rgb(0,159,255)] dark:text-black">
              <IconPlus />
            </span>{' '}
            button to add code comments.
          </p>
        </div>
      </div>
    );
  }

  return (
    <RowVisibilityContext value={observeRow}>
      <div
        ref={scrollerRef}
        className={cn(
          'cv-mini-scrollbar',
          'h-full min-h-0 overflow-auto overscroll-contain pl-3 pb-3 pr-[max(0px,calc(12px-var(--cv-mini-gutter-vertical)))]'
        )}
      >
        {showConversation && (
          <section>
            <div className="text-muted-foreground p-3 pb-2 text-sm font-medium">
              Conversation
            </div>
            <div className={cn(CARD_BORDER_CLASS, 'rounded-lg border')}>
              {discussion.map((comment) => (
                <DiscussionRow
                  key={`${comment.kind}-${comment.id}`}
                  actions={discussionActions}
                  comment={comment}
                />
              ))}
              {discussionActions != null && (
                <DiscussionComposerRow actions={discussionActions} />
              )}
            </div>
          </section>
        )}
        {commentSections.map((section) => (
          <section key={section.itemId}>
            {onSelectItem != null ? (
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring block w-full cursor-pointer p-3 pb-2 text-left text-sm font-medium break-all outline-none focus-visible:ring-2"
                onClick={(event) =>
                  handleRowClick(event, () => onSelectItem(section.itemId))
                }
              >
                <span className="select-text">{section.path}</span>
              </button>
            ) : (
              <div className="text-muted-foreground p-3 pb-2 text-sm font-medium break-all">
                {section.path}
              </div>
            )}
            <div className={cn(CARD_BORDER_CLASS, 'rounded-lg border')}>
              {section.comments.map((comment) => (
                <CommentRow
                  key={comment.key}
                  onActivate={() => onSelectComment?.(comment)}
                >
                  <CommentAuthorAvatar
                    author={comment.author}
                    className="size-5"
                  />
                  <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5 select-text">
                    <div className="text-muted-foreground flex flex-wrap gap-x-1">
                      <span className="text-foreground font-medium">
                        @{comment.author.login}
                      </span>
                      <span>commented on</span>
                      <span
                        className={cn(
                          getCommentLineClassName(
                            comment.side,
                            comment.lineType
                          ),
                          'font-medium'
                        )}
                      >
                        {getCommentLineLabel(
                          comment.side,
                          comment.lineNumber,
                          comment.lineType
                        )}
                      </span>
                    </div>
                    <DeferredMarkdown
                      className={COLLAPSED_SIDEBAR_MARKDOWN_CLASS}
                      markdown={comment.message}
                    />
                    {comment.replyCount > 0 && (
                      <div className="text-muted-foreground mt-1 flex items-center gap-1.5 text-[12px]">
                        <span className="flex -space-x-1.5">
                          {comment.participants
                            .slice(0, 4)
                            .map((participant) => (
                              <CommentAuthorAvatar
                                key={participant.login}
                                author={participant}
                                className="size-4 text-[8px] ring-2 ring-[var(--diffshub-card-bg,var(--color-card))]"
                              />
                            ))}
                        </span>
                        <span>
                          {comment.replyCount}{' '}
                          {comment.replyCount === 1 ? 'reply' : 'replies'}
                          {comment.participants.length > 1 &&
                            ` · ${comment.participants.length} participants`}
                        </span>
                      </div>
                    )}
                  </div>
                </CommentRow>
              ))}
            </div>
          </section>
        ))}
      </div>
    </RowVisibilityContext>
  );
});
