import { cn } from '@/lib/cn';

// A GitHub label's color swatch. Renders nothing for a color that isn't six
// hex digits, so a malformed color can't inject other CSS.
export function LabelColorDot({
  className = 'size-2',
  color,
}: {
  className?: string;
  color: string;
}) {
  if (!/^[0-9a-fA-F]{6}$/.test(color)) {
    return null;
  }
  return (
    <span
      aria-hidden
      className={cn('shrink-0 rounded-full', className)}
      style={{ backgroundColor: `#${color}` }}
    />
  );
}
