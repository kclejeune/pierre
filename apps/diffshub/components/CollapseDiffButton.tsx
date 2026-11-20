import { IconChevronSm } from '@pierre/icons';

import { FILE_HEADER_ICON_BUTTON_CLASS } from './chromeButtonStyles';
import { cn } from '@/lib/cn';

interface CollapseDiffButtonProps {
  disabled?: boolean;
  collapsed?: boolean;
  onToggle(): void;
}

// The chevron before a diff file's name that collapses or expands the file,
// shared by the review page's viewer and the /pulls quick look.
export function CollapseDiffButton({
  disabled = false,
  collapsed = false,
  onToggle,
}: CollapseDiffButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-expanded={!disabled && !collapsed}
      aria-hidden={disabled}
      aria-label={
        disabled ? undefined : collapsed ? 'Expand diff' : 'Collapse diff'
      }
      className={cn(
        FILE_HEADER_ICON_BUTTON_CLASS,
        'ml-[-8px] disabled:pointer-events-none disabled:opacity-50'
      )}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
    >
      <IconChevronSm
        aria-hidden="true"
        className={cn(
          'size-4 transition-transform',
          (disabled || collapsed) && '-rotate-90'
        )}
      />
    </button>
  );
}
