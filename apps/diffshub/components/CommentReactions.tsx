'use client';

import { IconEmojiSmile } from '@pierre/icons';
import { useState } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from './DropdownMenu';
import { saveViewerReaction } from './reactionsClient';
import { useDropdownChromeStyle } from './useDropdownChromeStyle';
import { Button } from '@/components/Button';
import { cn } from '@/lib/cn';
import {
  type CommentReaction,
  getReactionDefinition,
  hasViewerReacted,
  type ReactionContent,
  REACTIONS,
  toggleReaction,
} from '@/lib/reactions';
import { toastError } from '@/lib/toastRequestError';

interface CommentReactionsProps {
  // Whether the viewer can react: a saved token, and GitHub said which
  // reactions are already theirs. Reacting also needs nodeId.
  canReact: boolean;
  nodeId: string | undefined;
  reactions: readonly CommentReaction[] | undefined;
  // Fired with the tallies after each toggle (optimistically, and again with
  // the previous tallies when GitHub refuses), so the owner can keep them
  // across remounts.
  onChange?(reactions: readonly CommentReaction[]): void;
}

// Reaction state for one comment: the current tallies (optimistic while a
// toggle is in flight) and a toggle that rolls back if GitHub refuses. One
// toggle is sent at a time: GitHub can apply concurrent add and remove
// requests in either order, and a rollback would undo a later toggle. Split
// from the rendering so a layout can place the chips and the picker apart.
export interface CommentReactionsState {
  interactive: boolean;
  isSaving: boolean;
  reactions: readonly CommentReaction[];
  toggle(content: ReactionContent): void;
}

export function useCommentReactions({
  canReact,
  nodeId,
  reactions: reactionsProp,
  onChange,
}: CommentReactionsProps): CommentReactionsState {
  const [reactions, setReactions] = useState<readonly CommentReaction[]>(
    reactionsProp ?? []
  );
  // Adopt fresh tallies when the comment reloads from GitHub.
  const [seenProp, setSeenProp] = useState(reactionsProp);
  if (seenProp !== reactionsProp) {
    setSeenProp(reactionsProp);
    setReactions(reactionsProp ?? []);
  }
  const [isSaving, setIsSaving] = useState(false);
  const interactive = canReact && nodeId != null;

  const toggle = (content: ReactionContent) => {
    if (!canReact || nodeId == null || isSaving) {
      return;
    }
    const previous = reactions;
    const next = toggleReaction(previous, content);
    const adding = !hasViewerReacted(previous, content);
    setReactions(next);
    onChange?.(next);
    setIsSaving(true);
    saveViewerReaction(nodeId, content, adding)
      .catch((error: unknown) => {
        setReactions(previous);
        onChange?.(previous);
        toastError(error, 'The reaction could not be saved.');
      })
      .finally(() => setIsSaving(false));
  };

  return { interactive, isSaving, reactions, toggle };
}

// A comment's reaction chips in a wrapping row; renders nothing when the
// comment has no reactions.
export function ReactionChipList({
  className,
  state,
}: {
  className?: string;
  state: CommentReactionsState;
}) {
  if (state.reactions.length === 0) {
    return null;
  }
  return (
    <div
      aria-busy={state.isSaving}
      className={cn('flex flex-wrap items-center gap-1', className)}
    >
      {state.reactions.map((reaction) => {
        const { emoji, label } = getReactionDefinition(reaction.content);
        return (
          <button
            key={reaction.content}
            type="button"
            aria-label={`${label}: ${reaction.count}`}
            aria-pressed={reaction.viewerHasReacted}
            disabled={!state.interactive}
            title={label}
            className={cn(
              'flex h-6 items-center gap-1 rounded-full border px-2 text-[12px] tabular-nums transition-colors',
              reaction.viewerHasReacted
                ? 'border-blue-500/60 bg-blue-500/10 text-blue-600 dark:text-blue-300'
                : 'text-muted-foreground border-[var(--diffshub-annotation-border,var(--color-border))]',
              state.interactive && 'hover:border-foreground/30 cursor-pointer'
            )}
            onClick={() => state.toggle(reaction.content)}
          >
            <span aria-hidden>{emoji}</span>
            {reaction.count}
          </button>
        );
      })}
    </div>
  );
}

// The smiley button that opens the reaction picker; callers gate it on
// `state.interactive`. The picker body mounts only while open so closed
// pickers don't each resolve the dropdown chrome theme.
export function AddReactionButton({ state }: { state: CommentReactionsState }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <DropdownMenu modal={false} open={pickerOpen} onOpenChange={setPickerOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Add reaction"
          title="Add reaction"
          className="text-muted-foreground size-6 rounded-full"
        >
          <IconEmojiSmile size={14} />
        </Button>
      </DropdownMenuTrigger>
      {pickerOpen && (
        <ReactionPicker
          reactions={state.reactions}
          onPick={(content) => {
            setPickerOpen(false);
            state.toggle(content);
          }}
        />
      )}
    </DropdownMenu>
  );
}

// The picker menu's body. Its own component so the chrome-theme hook runs
// only while a picker is open, not once per rendered comment.
function ReactionPicker({
  onPick,
  reactions,
}: {
  onPick(content: ReactionContent): void;
  reactions: readonly CommentReaction[];
}) {
  const dropdownStyle = useDropdownChromeStyle();
  return (
    <DropdownMenuContent
      align="start"
      className="flex gap-0.5 p-1"
      style={dropdownStyle}
    >
      {REACTIONS.map(({ content, emoji, label }) => {
        const mine = hasViewerReacted(reactions, content);
        return (
          <button
            key={content}
            type="button"
            aria-label={label}
            aria-pressed={mine}
            title={label}
            className={cn(
              'hover:bg-muted flex size-8 cursor-pointer items-center justify-center rounded-md text-[16px] transition-colors',
              mine && 'bg-blue-500/10'
            )}
            onClick={() => onPick(content)}
          >
            {emoji}
          </button>
        );
      })}
    </DropdownMenuContent>
  );
}
