'use client';

import { createContext, useContext } from 'react';

// The login of the open pull request's author, or null outside pull-request
// views (and until the pull's details load). Comment headers read it to show
// GitHub's "Author" badge. A context rather than props because thread cards
// render from the viewer's identity-stable annotation callbacks, which would
// not re-render when the details arrive after the threads.
export const PullAuthorContext = createContext<string | null>(null);

// Whether `login` opened the pull request being viewed.
export function useIsPullAuthor(login: string): boolean {
  const author = useContext(PullAuthorContext);
  return author != null && author === login;
}
