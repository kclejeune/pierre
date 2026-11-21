'use client';

import type { AnnotationSide } from '@pierre/diffs';
import {
  IconArrowUpRight,
  IconCheck,
  IconConvoFill,
  IconPlus,
} from '@pierre/icons';
import { ChevronDown } from 'lucide-react';
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
  useMemo,
  useRef,
  useState,
} from 'react';

import { Button } from './Button';
import { ButtonGroup, ButtonGroupItem } from './ButtonGroup';
import { CommentHeaderActions, CommentTimestamp } from './CommentActions';
import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import { CommentComposer, ComposerTrigger } from './CommentComposer';
import {
  CommentDeleteConfirm,
  CommentEditComposer,
  useCommentModeration,
} from './CommentModeration';
import { ReactionChipList, useCommentReactions } from './CommentReactions';
import { MarkdownContent, RawMarkdownFallback } from './MarkdownContent';
import { SidebarPanelHeader } from './SidebarPanelHeader';
import { useGitHubUser } from './useGitHubUser';
import { annotationBorderColor } from '@/lib/annotation';
import { cn } from '@/lib/cn';
import { readCommentDraft } from '@/lib/commentDrafts';
import {
  createCommentSidebarPreview,
  summarizeCommentBody,
} from '@/lib/commentSidebarPreview';
import type { DiffHunkSnippetLine } from '@/lib/diffHunkSnippet';
import type {
  CommentAuthor,
  CommentLineType,
  DiffsHubSavedCommentEntry,
  DiffsHubSavedCommentItem,
  PullDiscussionComment,
} from '@/lib/types';

// One sidebar entry. Every entry (the description, each conversation
// comment, each review thread) is its own bordered card in a gapped stack, as
// on GitHub's timeline, so independent comments don't read as one thread.
// The border and surface come from themed CSS variables (set on the sidebar
// wrapper) so cards stay on-palette for mixed-light/dark themes like
// slack-ochin (light-typed but uses a dark navy sidebar); the hardcoded
// fallbacks cover the brief window before the Shiki theme resolves on first
// render.
const CARD_CLASS =
  'rounded-lg border border-[var(--diffshub-card-border,rgb(0_0_0_/_0.1))] bg-[var(--diffshub-card-bg,var(--color-card))] dark:border-[var(--diffshub-card-border,rgb(255_255_255_/_0.15))]';

// Divides the list's two groups (the pull's conversation, its code
// comments) when both are present: a small muted label, its count, and a
// hairline rule, so it reads as a section break under the panel's own
// "Comments" title rather than a second title.
function GroupHeading({ count, label }: { count: number; label: string }) {
  return (
    <h3 className="text-muted-foreground flex items-center gap-2 pt-2 pb-2 text-xs font-medium">
      {label}
      <span className="tabular-nums">{count}</span>
      <span aria-hidden="true" className="bg-border h-px flex-1" />
    </h3>
  );
}

// The gapped stack of cards under each section heading.
const CARD_STACK_CLASS = 'flex flex-col gap-2';

// A card's header line: the author's avatar, the who/what/when text in
// `children`, and an optional `trailing` slot (actions, a status tag). The
// text wraps within its own column so the trailing slot never drops below it.
function CardHeader({
  author,
  children,
  trailing,
}: {
  author: CommentAuthor | null;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className="text-muted-foreground flex min-h-6 w-full items-center gap-2">
      {author != null && (
        <CommentAuthorAvatar author={author} className="size-5" />
      )}
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1">
        {children}
      </span>
      {trailing}
    </div>
  );
}

// Comment bodies in sidebar rows render as markdown at the row's 14px size,
// with the prose spacing tightened so a one-line comment stays one line.
const SIDEBAR_MARKDOWN_CLASS =
  'text-foreground w-full text-[14px] leading-normal [&_p]:my-0! [&_p+p]:mt-2! [&_pre]:my-1.5! [&_ul]:my-1! [&_ol]:my-1! [&_blockquote]:my-1! [&_img]:max-h-40 [&_h1]:text-[1.15em]! [&_h2]:text-[1.1em]! [&_h3]:text-[1em]! [&_:is(h1,h2,h3)]:my-1.5!';

// Code comment cards clamp the rendered body to a few lines so long
// comments do not swallow the list while the formatting still reads at a
// glance (conversation rows collapse to a summary instead; see
// ConversationBody). `-webkit-line-clamp` counts lines across the nested markdown blocks,
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
    return (
      <MarkdownContent
        className={className}
        flavor="comment"
        markdown={markdown}
      />
    );
  }
  return (
    <RawMarkdownFallback ref={ref} className={className} markdown={markdown} />
  );
}

// A conversation row's body. Collapsed, a row whose comment holds more
// than its summary (summarizeCommentBody: the first line of text, as plain
// text) shows just that summary, so every collapsed row is the same compact
// height whatever the comment's markdown (a bot's headings and checklists
// clamp to most of a card otherwise). Expanded, or when the summary is the
// whole comment, the full markdown renders.
function ConversationBody({
  expanded,
  markdown,
  summary,
}: {
  expanded: boolean;
  markdown: string;
  summary: { hasMore: boolean; summary: string };
}) {
  if (summary.hasMore && !expanded) {
    return (
      <p className="text-foreground/80 m-0 line-clamp-2 w-full text-[13px] leading-5">
        {summary.summary === '' ? 'Show comment' : summary.summary}
      </p>
    );
  }
  return (
    <div className="w-full">
      <DeferredMarkdown
        className={SIDEBAR_MARKDOWN_CLASS}
        markdown={markdown}
      />
    </div>
  );
}

// A conversation row's collapse state: expanded or not, the body's summary
// (summarizeCommentBody), and a toggle that only acts when there's more to
// show and `canToggle` allows (not mid-edit). `rowProps` wires the toggle to
// the row's click and announces the state only on rows that can expand.
function useCollapsibleSummary(preview: string, canToggle = true) {
  const [expanded, setExpanded] = useState(false);
  const summary = useMemo(() => summarizeCommentBody(preview), [preview]);
  const toggle = () => {
    if (summary.hasMore && canToggle) {
      setExpanded((prev) => !prev);
    }
  };
  return {
    expanded,
    rowProps: {
      'aria-expanded': summary.hasMore ? expanded : undefined,
      onActivate: toggle,
    },
    setExpanded,
    summary,
    toggle,
  };
}

// The accordion chevron at a collapsible row's header edge: points down
// while the row shows its summary and turns up once it's expanded. A button of
// its own (the row's click toggles too) so the affordance is keyboard
// reachable and announced.
function ExpandChevron({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={expanded ? 'Collapse comment' : 'Expand comment'}
      title={expanded ? 'Collapse' : 'Expand'}
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md outline-none hover:bg-[var(--diffshub-card-hover-bg,var(--color-muted))] focus-visible:ring-2"
      onClick={onToggle}
    >
      <ChevronDown
        aria-hidden
        className={cn(
          'size-3.5 motion-safe:transition-transform',
          expanded && 'rotate-180'
        )}
      />
    </button>
  );
}

// Write access to the PR-level conversation, provided only on pull-request
// views. `canWrite` mirrors the thread cards' meaning: a token is saved, so
// writes can be attempted at all. Edit/delete only apply to issue comments
// (kind 'comment'); review summaries are read-only.
export interface DiscussionActions {
  canWrite: boolean;
  // Keys the unsent new-comment draft to its pull request, so a draft started
  // on one PR doesn't reappear on another.
  draftKey: string;
  onDelete(commentId: number): Promise<void>;
  onEdit(commentId: number, body: string): Promise<void>;
  onPost(body: string): Promise<void>;
}

// The pull request description, shown first in Conversation as on GitHub.
export interface PullDescription {
  authorLogin?: string;
  body: string;
}

// Which comments the list shows, as on GitHub's PR comments panel:
// everything, the threads still open (no PR-level conversation, which can't
// be resolved), or the viewer's own (threads they started or replied in, and
// their conversation comments).
export type CommentFilter = 'all' | 'unresolved' | 'mine';

interface DiffsHubCommentsListProps {
  commentSections: readonly DiffsHubSavedCommentItem[];
  // Controlled by the sidebar, so the overview's Comments cell can open the
  // list on Unresolved.
  filter?: CommentFilter;
  onFilterChange?(filter: CommentFilter): void;
  description?: PullDescription | null;
  // PR-level conversation (issue comments, review summaries) shown in its own
  // section above the per-file threads.
  discussion?: readonly PullDiscussionComment[];
  discussionActions?: DiscussionActions;
  onSelectComment?(comment: DiffsHubSavedCommentEntry): void;
  onSelectItem?(itemId: string): void;
  // The count the panel's title shows (the sidebar tab badge's number).
  totalCount?: number;
}

// GitHub logins compare case-insensitively.
function isViewer(login: string, viewerLogin: string | undefined): boolean {
  return (
    viewerLogin != null && login.toLowerCase() === viewerLogin.toLowerCase()
  );
}

// The review threads a filter keeps, with files left out once none of
// theirs remain.
function filterCommentSections(
  sections: readonly DiffsHubSavedCommentItem[],
  filter: CommentFilter,
  viewerLogin: string | undefined
): readonly DiffsHubSavedCommentItem[] {
  if (filter === 'all') {
    return sections;
  }
  const keep = (comment: DiffsHubSavedCommentEntry) =>
    filter === 'unresolved'
      ? comment.resolved !== true
      : isViewer(comment.author.login, viewerLogin) ||
        comment.participants.some((participant) =>
          isViewer(participant.login, viewerLogin)
        );
  return sections.flatMap((section) => {
    const comments = section.comments.filter(keep);
    return comments.length === 0 ? [] : [{ ...section, comments }];
  });
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
  if (lineType === 'file') {
    return 'the file';
  }
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
  if (lineType === 'context' || lineType === 'file') {
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

// The code an outdated thread was written on, as GitHub shows it: the last
// lines of its hunk, ending at the commented line (marked), since the diff
// no longer has that line to scroll to.
function OutdatedSnippet({ lines }: { lines: readonly DiffHunkSnippetLine[] }) {
  return (
    <div
      className={`w-full overflow-x-auto rounded-md border ${annotationBorderColor} py-1 font-mono text-[12px] leading-5`}
    >
      {lines.map((line, index) => {
        const color =
          line.kind === 'addition'
            ? 'var(--diffshub-comment-add-fg,#047857)'
            : line.kind === 'deletion'
              ? 'var(--diffshub-comment-del-fg,#be123c)'
              : null;
        const commented = index === lines.length - 1;
        return (
          <div
            key={index}
            className={cn(
              'flex min-w-max pr-3',
              commented && 'shadow-[inset_2px_0_0_var(--color-ring)]'
            )}
            style={
              color == null
                ? undefined
                : {
                    background: `color-mix(in srgb, ${color} 10%, transparent)`,
                  }
            }
          >
            <span
              aria-hidden
              className="text-muted-foreground w-10 shrink-0 pr-2 text-right select-none"
            >
              {line.lineNumber}
            </span>
            <span
              aria-hidden
              className="w-3 shrink-0 select-none"
              style={color == null ? undefined : { color }}
            >
              {line.kind === 'addition'
                ? '+'
                : line.kind === 'deletion'
                  ? '-'
                  : ''}
            </span>
            <span className="whitespace-pre">{line.text}</span>
          </div>
        );
      })}
    </div>
  );
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
        CARD_CLASS,
        'focus-visible:ring-ring flex w-full cursor-pointer flex-col items-start gap-1.5 p-3 text-left text-sm outline-none select-text hover:bg-[var(--diffshub-card-hover-bg,var(--color-muted))] focus-visible:ring-2',
        className
      )}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        // Clicks inside portaled menus (reaction picker, comment actions)
        // bubble here through React even though they sit outside the row.
        if (
          !event.currentTarget.contains(target) ||
          (target !== event.currentTarget &&
            target.closest('a, button, form') != null)
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
// reading the comment stays in-app. The header matches the inline thread
// cards (CommentActions): the timestamp links to GitHub, and the Author
// badge, reaction picker, and overflow menu sit at its right. Signed-in
// authors get edit/delete in that menu on their own conversation comments
// (never on review summaries — see DiscussionActions).
function DiscussionRow({
  actions,
  comment,
}: {
  actions?: DiscussionActions;
  comment: PullDiscussionComment;
}) {
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
  const reactions = useCommentReactions({
    canReact:
      actions?.canWrite === true && comment.reactionsViewerUnknown !== true,
    nodeId: comment.nodeId,
    reactions: comment.reactions,
  });

  const {
    expanded,
    rowProps,
    setExpanded,
    summary,
    toggle: toggleExpanded,
  } = useCollapsibleSummary(
    preview,
    !moderation.isEditing && !moderation.isConfirmingDelete
  );

  return (
    <CommentRow {...rowProps}>
      <CardHeader
        author={comment.author}
        trailing={
          <span className="flex shrink-0 items-center gap-0.5">
            <CommentHeaderActions
              authorLogin={comment.author.login}
              editing={moderation.isEditing}
              menu={{
                canModify,
                htmlUrl: comment.htmlUrl,
                moderation,
                onBeginEdit: () => setExpanded(true),
              }}
              reactions={reactions}
            />
            {summary.hasMore && !moderation.isEditing && (
              <ExpandChevron expanded={expanded} onToggle={toggleExpanded} />
            )}
          </span>
        }
      >
        <span className="text-foreground font-medium">
          @{comment.author.login}
        </span>
        <span className={cn(getDiscussionVerbClassName(comment))}>
          {getDiscussionVerb(comment)}
        </span>
        <span aria-hidden>·</span>
        <CommentTimestamp
          className="text-[length:inherit]"
          htmlUrl={comment.htmlUrl}
          iso={comment.createdAt}
        />
      </CardHeader>
      {moderation.isEditing && actions != null ? (
        <div className="w-full">
          <CommentEditComposer
            draftKey={`discussion-edit:${comment.id}`}
            initialBody={comment.body}
            moderation={moderation}
            onEdit={(body) => actions.onEdit(comment.id, body)}
          />
        </div>
      ) : (
        preview !== '' && (
          <ConversationBody
            expanded={expanded}
            markdown={preview}
            summary={summary}
          />
        )
      )}
      {!moderation.isEditing && <ReactionChipList state={reactions} />}
      {moderation.isConfirmingDelete && actions != null && (
        <div className="w-full">
          <CommentDeleteConfirm moderation={moderation} />
        </div>
      )}
    </CommentRow>
  );
}

// Conversation's first row: the description, collapsed until clicked. Editing
// lives in the header's pull request panel.
function DescriptionRow({ description }: { description: PullDescription }) {
  const preview = createCommentSidebarPreview(description.body);
  const {
    expanded,
    rowProps,
    summary,
    toggle: toggleExpanded,
  } = useCollapsibleSummary(preview);
  return (
    <CommentRow {...rowProps}>
      <CardHeader
        trailing={
          summary.hasMore && (
            <ExpandChevron expanded={expanded} onToggle={toggleExpanded} />
          )
        }
        author={
          description.authorLogin != null
            ? { avatarUrl: '', login: description.authorLogin }
            : null
        }
      >
        {description.authorLogin != null && (
          <span className="text-foreground font-medium">
            @{description.authorLogin}
          </span>
        )}
        <span>
          {description.authorLogin != null
            ? 'opened this pull request'
            : 'Description'}
        </span>
      </CardHeader>
      {preview === '' ? (
        <p className="text-muted-foreground m-0 text-[13px]">
          No description provided.
        </p>
      ) : (
        <ConversationBody
          expanded={expanded}
          markdown={preview}
          summary={summary}
        />
      )}
    </CommentRow>
  );
}

// The footer pinned below the comments scroller: opens a composer that posts a
// new PR-level comment. It sits outside the scroller so it stays in reach
// however far the list is scrolled, and shows the viewer's avatar beside an
// input-styled trigger (on the sidebar background, not a card) so it doesn't
// read as another comment. Anonymous sessions get the same sign-in nudge as
// thread replies instead of a composer they could not submit.
const COMPOSER_FOOTER_CLASS =
  'max-h-[60%] shrink-0 overflow-y-auto border-t border-[var(--color-border-opaque)] p-3';

function DiscussionComposerFooter({ actions }: { actions: DiscussionActions }) {
  // Starts open when an unsent draft survives from earlier in the session, as
  // thread replies do, so the text doesn't hide behind the collapsed trigger.
  // Only a click focuses the editor; a restored draft shouldn't take focus.
  const [isOpen, setIsOpen] = useState(
    () => readCommentDraft(actions.draftKey) != null
  );
  const [openedByUser, setOpenedByUser] = useState(false);
  const githubUser = useGitHubUser();

  if (!actions.canWrite) {
    return (
      <p
        className={cn(
          COMPOSER_FOOTER_CLASS,
          'text-muted-foreground m-0 text-[13px]'
        )}
      >
        Sign in with GitHub or save a token to comment.
      </p>
    );
  }

  return (
    <div className={COMPOSER_FOOTER_CLASS}>
      {isOpen ? (
        <CommentComposer
          autoFocus={openedByUser}
          draftKey={actions.draftKey}
          submitLabel="Comment"
          onCancel={() => setIsOpen(false)}
          onSubmit={async (body) => {
            await actions.onPost(body);
            setIsOpen(false);
          }}
        />
      ) : (
        <div className="flex items-center gap-2">
          {githubUser != null && (
            // Overrides the avatar's default top alignment.
            <CommentAuthorAvatar author={githubUser} className="self-center" />
          )}
          <ComposerTrigger
            className="border-[var(--color-border-opaque)] bg-[var(--diffshub-card-bg,var(--color-card))] py-2 shadow-xs"
            label="Comment on this pull request…"
            onOpen={() => {
              setOpenedByUser(true);
              setIsOpen(true);
            }}
          />
        </div>
      )}
    </div>
  );
}

export const DiffsHubCommentsList = memo(function DiffsHubCommentsList({
  commentSections: allSections,
  description: fullDescription,
  discussion: allDiscussion = [],
  discussionActions,
  filter = 'all',
  onFilterChange,
  onSelectComment,
  onSelectItem,
  totalCount,
}: DiffsHubCommentsListProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const observeRow = useRowVisibilityObserver(scrollerRef);
  const viewerLogin = useGitHubUser()?.login;
  // Mine needs to know who the viewer is; without a signed-in user it reads
  // as All.
  const activeFilter =
    filter === 'mine' && viewerLogin == null ? 'all' : filter;
  const unresolvedCount = useMemo(
    () =>
      allSections.reduce(
        (count, section) =>
          count +
          section.comments.filter((comment) => comment.resolved !== true)
            .length,
        0
      ),
    [allSections]
  );
  const commentSections = useMemo(
    () => filterCommentSections(allSections, activeFilter, viewerLogin),
    [activeFilter, allSections, viewerLogin]
  );
  const discussion =
    activeFilter === 'all'
      ? allDiscussion
      : activeFilter === 'mine'
        ? allDiscussion.filter((comment) =>
            isViewer(comment.author.login, viewerLogin)
          )
        : [];
  const description = activeFilter === 'all' ? fullDescription : null;
  const showConversation = discussion.length > 0 || description != null;
  // With only one group, the panel's title already names it.
  const showGroupHeadings = showConversation && commentSections.length > 0;
  // The filter only matters once there are review threads to narrow.
  const showFilter = onFilterChange != null && allSections.length > 0;
  const filteredEmpty =
    activeFilter !== 'all' && commentSections.length === 0 && !showConversation;
  // On pull-request views the composer footer is how PR-level comments get
  // written, so the empty state only applies when there is nothing to show
  // AND nothing to write.
  if (
    activeFilter === 'all' &&
    commentSections.length === 0 &&
    !showConversation &&
    discussionActions == null
  ) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <SidebarPanelHeader title="Comments" />
        <div className="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-7 text-center text-sm">
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
      </div>
    );
  }

  return (
    <RowVisibilityContext value={observeRow}>
      <div className="flex h-full min-h-0 flex-col">
        <SidebarPanelHeader title="Comments" count={totalCount}>
          {showFilter && (
            <ButtonGroup
              size="xs"
              aria-label="Show comments"
              value={activeFilter}
              onValueChange={(value) => onFilterChange(value as CommentFilter)}
            >
              <ButtonGroupItem value="all">All</ButtonGroupItem>
              <ButtonGroupItem value="unresolved" className="gap-1">
                Unresolved
                {unresolvedCount > 0 && (
                  <span className="text-muted-foreground tabular-nums">
                    {unresolvedCount}
                  </span>
                )}
              </ButtonGroupItem>
              {viewerLogin != null && (
                <ButtonGroupItem value="mine">Mine</ButtonGroupItem>
              )}
            </ButtonGroup>
          )}
        </SidebarPanelHeader>
        <div
          ref={scrollerRef}
          className={cn(
            'cv-mini-scrollbar',
            'min-h-0 flex-1 overflow-auto overscroll-contain pl-3 pb-3 pr-[max(0px,calc(12px-var(--cv-mini-gutter-vertical)))]'
          )}
        >
          {filteredEmpty && (
            <div className="text-muted-foreground flex flex-col items-center gap-2 px-4 py-8 text-center text-sm">
              <p>
                {activeFilter === 'unresolved'
                  ? 'Every thread is resolved.'
                  : 'You haven’t commented on this pull request yet.'}
              </p>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => onFilterChange?.('all')}
              >
                Show all comments
              </Button>
            </div>
          )}
          {showConversation && (
            <section>
              {showGroupHeadings && (
                <GroupHeading
                  // Comments only, like the tab badge; the description isn't one.
                  count={discussion.length}
                  label="Conversation"
                />
              )}
              <div className={CARD_STACK_CLASS}>
                {description != null && (
                  <DescriptionRow description={description} />
                )}
                {discussion.map((comment) => (
                  <DiscussionRow
                    key={`${comment.kind}-${comment.id}`}
                    actions={discussionActions}
                    comment={comment}
                  />
                ))}
              </div>
            </section>
          )}
          {showGroupHeadings && (
            <div className="mt-2">
              <GroupHeading
                count={commentSections.reduce(
                  (total, section) => total + section.comments.length,
                  0
                )}
                label="Code comments"
              />
            </div>
          )}
          {commentSections.map((section) => (
            <section key={section.itemId}>
              {/* A file the diff doesn't show (its threads are listed from
                  GitHub only) has nothing to scroll to. */}
              {onSelectItem != null &&
              section.comments.some(
                (comment) => comment.detached?.fileInDiff !== false
              ) ? (
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
              <div className={CARD_STACK_CLASS}>
                {section.comments.map((comment) => (
                  <CommentRow
                    key={comment.key}
                    onActivate={() => onSelectComment?.(comment)}
                  >
                    <CardHeader
                      author={comment.author}
                      trailing={
                        (comment.detached?.outdated === true ||
                          comment.resolved === true) && (
                          <span className="inline-flex shrink-0 items-center gap-2 text-[12px]">
                            {comment.detached?.outdated === true && (
                              <span
                                className="rounded-full border px-1.5 leading-4"
                                title="The line this thread is on has changed since it was written"
                              >
                                Outdated
                              </span>
                            )}
                            {comment.resolved === true && (
                              <span className="inline-flex items-center gap-1">
                                <IconCheck size={12} aria-hidden />
                                Resolved
                              </span>
                            )}
                          </span>
                        )
                      }
                    >
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
                    </CardHeader>
                    {comment.detached?.snippet != null && (
                      <OutdatedSnippet lines={comment.detached.snippet} />
                    )}
                    <DeferredMarkdown
                      className={COLLAPSED_SIDEBAR_MARKDOWN_CLASS}
                      markdown={comment.message}
                    />
                    {comment.detached?.htmlUrl != null && (
                      // Threads without a card in the diff are read and
                      // answered on GitHub.
                      <a
                        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[12px] underline-offset-2 hover:underline"
                        href={comment.detached.htmlUrl}
                        rel="noreferrer"
                        target="_blank"
                      >
                        View on GitHub
                        <IconArrowUpRight size={12} aria-hidden />
                      </a>
                    )}
                    {comment.replyCount > 0 && (
                      <div className="text-muted-foreground flex items-center gap-1.5 text-[12px]">
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
                  </CommentRow>
                ))}
              </div>
            </section>
          ))}
        </div>
        {discussionActions != null && (
          <DiscussionComposerFooter
            // Remounts per pull request so the composer reloads that PR's
            // draft instead of carrying the previous one's open editor over.
            key={discussionActions.draftKey}
            actions={discussionActions}
          />
        )}
      </div>
    </RowVisibilityContext>
  );
});
