import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/formatRelativeTime';

const ABSOLUTE_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

// Relative age with the exact date as its tooltip. `titlePrefix` labels it
// ("Updated ").
export function RelativeTime({
  className,
  iso,
  titlePrefix = '',
}: {
  className?: string;
  iso: string;
  titlePrefix?: string;
}) {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) {
    return null;
  }
  return (
    <time
      className={cn('tabular-nums', className)}
      dateTime={iso}
      title={titlePrefix + ABSOLUTE_FORMAT.format(timestamp)}
    >
      {formatRelativeTime(iso)}
    </time>
  );
}
