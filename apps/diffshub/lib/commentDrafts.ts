// Unsent comment text by key (e.g. `reply:<item>:<thread>`). Module scope
// because the virtualized diff unmounts thread cards offscreen. A reload starts
// fresh.
const drafts = new Map<string, string>();

export function readCommentDraft(key: string): string | undefined {
  return drafts.get(key);
}

export function writeCommentDraft(key: string, body: string): void {
  if (body === '') {
    drafts.delete(key);
  } else {
    drafts.set(key, body);
  }
}

export function clearCommentDraft(key: string): void {
  drafts.delete(key);
}
