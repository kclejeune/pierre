'use client';

import { IconPencil, IconTrash } from '@pierre/icons';
import { useState } from 'react';

import { CommentComposer } from './CommentComposer';
import { InlineConfirm } from './InlineConfirm';
import { Button } from '@/components/Button';

// The own-comment edit/delete state machine shared by the sidebar's
// Conversation rows and the inline diff thread comments: an edit-mode toggle,
// a delete confirmation step, and an in-flight delete flag that re-enables
// the controls if the delete fails. Callers own layout (hover-reveal
// wrappers, spacing) since it differs per site.
export interface CommentModeration {
  isConfirmingDelete: boolean;
  isDeleting: boolean;
  isEditing: boolean;
  cancelDelete(): void;
  cancelEditing(): void;
  confirmDelete(): void;
  requestDelete(): void;
  startEditing(): void;
}

export function useCommentModeration(
  onDelete: () => Promise<void>
): CommentModeration {
  const [isEditing, setIsEditing] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  return {
    isConfirmingDelete,
    isDeleting,
    isEditing,
    cancelDelete: () => setIsConfirmingDelete(false),
    cancelEditing: () => setIsEditing(false),
    confirmDelete: () => {
      setIsDeleting(true);
      onDelete().catch(() => {
        // Failure already surfaced; re-enable the controls.
        setIsDeleting(false);
      });
    },
    requestDelete: () => setIsConfirmingDelete(true),
    // Entering edit mode dismisses a pending delete confirmation so the two
    // affordances never render together.
    startEditing: () => {
      setIsConfirmingDelete(false);
      setIsEditing(true);
    },
  };
}

// The pencil/trash icon pair. `onBeginEdit` lets a site run extra work before
// the composer opens (e.g. expanding a collapsed discussion row).
export function CommentModerationButtons({
  moderation,
  onBeginEdit,
}: {
  moderation: CommentModeration;
  onBeginEdit?(): void;
}) {
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Edit comment"
        title="Edit comment"
        disabled={moderation.isDeleting}
        onClick={() => {
          onBeginEdit?.();
          moderation.startEditing();
        }}
      >
        <IconPencil size={12} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Delete comment"
        title="Delete comment"
        disabled={moderation.isDeleting}
        onClick={moderation.requestDelete}
      >
        <IconTrash size={12} />
      </Button>
    </>
  );
}

// The comment body swapped into a save-mode composer while editing.
export function CommentEditComposer({
  initialBody,
  moderation,
  onEdit,
}: {
  initialBody: string;
  moderation: CommentModeration;
  onEdit(body: string): Promise<void>;
}) {
  return (
    <CommentComposer
      autoFocus
      initialBody={initialBody}
      submitLabel="Save"
      onCancel={moderation.cancelEditing}
      onSubmit={async (body) => {
        await onEdit(body);
        moderation.cancelEditing();
      }}
    />
  );
}

// The delete confirmation row; callers gate rendering on
// `moderation.isConfirmingDelete` so wrapper spacing stays site-local.
export function CommentDeleteConfirm({
  moderation,
}: {
  moderation: CommentModeration;
}) {
  return (
    <InlineConfirm
      confirmLabel="Delete"
      disabled={moderation.isDeleting}
      message="Delete this comment on GitHub?"
      onCancel={moderation.cancelDelete}
      onConfirm={moderation.confirmDelete}
    />
  );
}
