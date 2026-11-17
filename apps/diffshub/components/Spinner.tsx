import { IconRefresh } from '@pierre/icons';

import { cn } from '@/lib/cn';

// The app's one busy indicator: the refresh icon, mirrored and spun in
// reverse so its arrows point the way it turns. Decorative; pair it with
// aria-busy or status text on the surrounding element. `className` sets size,
// color, and spacing.
export function Spinner({ className }: { className?: string }) {
  return (
    <IconRefresh
      aria-hidden="true"
      className={cn(
        '-scale-x-100 animate-spin [animation-direction:reverse] motion-reduce:animate-none',
        className
      )}
    />
  );
}
