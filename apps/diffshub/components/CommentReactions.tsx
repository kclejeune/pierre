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

// A comment's emoji reactions: a chip per reaction with its count
// (highlighted when one is the viewer's; clicking toggles it) and a picker
// for adding one. Changes show immediately and roll back if GitHub refuses.
// One toggle is sent at a time: GitHub can apply concurrent add and remove
// requests in either order, and a rollback would undo a later toggle.
export function CommentReactions({
  canReact,
  nodeId,
  reactions: reactionsProp,
  onChange,
}: CommentReactionsProps) {
  const [reactions, setReactions] = useState<readonly CommentReaction[]>(
    reactionsProp ?? []
  );
  // Adopt fresh tallies when the comment reloads from GitHub.
  const [seenProp, setSeenProp] = useState(reactionsProp);
  if (seenProp !== reactionsProp) {
    setSeenProp(reactionsProp);
    setReactions(reactionsProp ?? []);
  }
  const [pickerOpen, setPickerOpen] = useState(false);
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

  if (reactions.length === 0 && !interactive) {
    return null;
  }

  return (
    <div
      aria-busy={isSaving}
      className="mt-1 flex flex-wrap items-center gap-1"
    >
      {reactions.map((reaction) => {
        const { emoji, label } = getReactionDefinition(reaction.content);
        return (
          <button
            key={reaction.content}
            type="button"
            aria-label={`${label}: ${reaction.count}`}
            aria-pressed={reaction.viewerHasReacted}
            disabled={!interactive}
            title={label}
            className={cn(
              'flex h-6 items-center gap-1 rounded-full border px-2 text-[12px] tabular-nums transition-colors',
              reaction.viewerHasReacted
                ? 'border-blue-500/60 bg-blue-500/10 text-blue-600 dark:text-blue-300'
                : 'text-muted-foreground border-[var(--diffshub-annotation-border,var(--color-border))]',
              interactive && 'hover:border-foreground/30 cursor-pointer'
            )}
            onClick={() => toggle(reaction.content)}
          >
            <span aria-hidden>{emoji}</span>
            {reaction.count}
          </button>
        );
      })}
      {interactive && (
        <DropdownMenu
          modal={false}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
        >
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Add reaction"
              title="Add reaction"
              className={cn(
                'text-muted-foreground size-6 rounded-full',
                reactions.length === 0 &&
                  'opacity-0 group-focus-within/comment:opacity-100 group-hover/comment:opacity-100 group-focus-within/discussion:opacity-100 group-hover/discussion:opacity-100 data-[state=open]:opacity-100'
              )}
            >
              <IconEmojiSmile size={14} />
            </Button>
          </DropdownMenuTrigger>
          <ReactionPicker
            reactions={reactions}
            onPick={(content) => {
              setPickerOpen(false);
              toggle(content);
            }}
          />
        </DropdownMenu>
      )}
    </div>
  );
}

// The picker menu's body. Its own component so the chrome-theme hook runs
// only while a picker is open (Radix mounts menu content on open), not once
// per rendered comment.
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
