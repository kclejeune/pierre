import { toast } from 'sonner';

// Surfaces a failed GitHub write as an error toast, then rethrows so the
// caller's in-progress UI (a composer, a confirm flow) keeps its state
// instead of clearing as if the write had succeeded.
export function toastRequestError(error: unknown, fallback: string): never {
  toast.error(error instanceof Error ? error.message : fallback);
  throw error;
}
