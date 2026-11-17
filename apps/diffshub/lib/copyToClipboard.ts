import { toast } from 'sonner';

// Copies `text` and confirms with a toast named after what was copied
// ("Link copied" / "The link could not be copied."), so every copy button in
// the app reports the same way.
export function copyToClipboard(text: string, what: string): void {
  navigator.clipboard.writeText(text).then(
    () => toast(`${what} copied`),
    () => toast.error(`The ${what.toLowerCase()} could not be copied.`)
  );
}
