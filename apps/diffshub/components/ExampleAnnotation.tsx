import type { CodeViewLineSelection, DiffLineAnnotation } from '@pierre/diffs';
import { IconPencil, IconX } from '@pierre/icons';
import { memo, useState } from 'react';

import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import { CommentComposer } from './CommentComposer';
import { Button } from '@/components/Button';
import { annotationCardBase } from '@/lib/annotation';
import { cn } from '@/lib/cn';
import type { SavedCommentMetadata } from '@/lib/types';

interface ExampleAnnotationProps {
  annotation: DiffLineAnnotation<SavedCommentMetadata>;
  itemId: string;
  onDelete(itemId: string, key: string): void;
  onEdit(itemId: string, key: string, message: string): void;
  onToggleSelection(selection: CodeViewLineSelection): void;
}

export const ExampleAnnotation = memo(function ExampleAnnotation({
  annotation,
  itemId,
  onDelete,
  onEdit,
  onToggleSelection,
}: ExampleAnnotationProps) {
  const [isEditing, setIsEditing] = useState(false);
  const selection = { id: itemId, range: annotation.metadata.range };

  if (isEditing) {
    return (
      <div className={cn(annotationCardBase)}>
        <CommentAuthorAvatar author={annotation.metadata.author} />
        <CommentComposer
          autoFocus
          initialBody={annotation.metadata.message}
          submitLabel="Save"
          onCancel={() => setIsEditing(false)}
          onSubmit={(message) => {
            onEdit(itemId, annotation.metadata.key, message);
            setIsEditing(false);
          }}
        />
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className={cn(
        annotationCardBase,
        'group relative cursor-pointer hover:border-[var(--diffshub-annotation-hover-border,var(--diffshub-annotation-border,var(--color-border)))]'
      )}
      onClick={() => onToggleSelection(selection)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
          return;
        }
        event.preventDefault();
        onToggleSelection(selection);
      }}
    >
      <CommentAuthorAvatar author={annotation.metadata.author} />
      <span className="pointer-events-none absolute top-0 right-0 z-1 inline-flex translate-x-[35%] -translate-y-[35%] gap-1 opacity-0 transition-opacity duration-100 group-hover:pointer-events-auto group-hover:opacity-100">
        <Button
          variant="default"
          size="icon-sm"
          aria-label="Edit comment"
          onClick={(event) => {
            event.stopPropagation();
            setIsEditing(true);
          }}
          className="cursor-pointer rounded-full bg-neutral-500 shadow-[inherit]"
        >
          <IconPencil size={12} />
        </Button>
        <Button
          variant="default"
          size="icon-sm"
          aria-label="Delete comment"
          onClick={(event) => {
            event.stopPropagation();
            onDelete(itemId, annotation.metadata.key);
          }}
          className="cursor-pointer rounded-full bg-neutral-500 shadow-[inherit]"
        >
          <IconX size={12} />
        </Button>
      </span>
      <div className="flex flex-col">
        <strong className="mt-1 flex items-center gap-2 text-[14px]">
          {annotation.metadata.author.login}
          {annotation.metadata.pending === true && (
            <span
              className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber-600 uppercase dark:text-amber-400"
              title="Part of your unsubmitted review"
            >
              Pending
            </span>
          )}
        </strong>
        <p className="m-0 text-[14px] whitespace-pre-wrap">
          {annotation.metadata.message}
        </p>
      </div>
    </div>
  );
});
