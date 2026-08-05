import { getGitHubPathFromURL } from './getGitHubPathFromURL';

export function getGitHubPath(
  input: string,
  githubHost?: string
): string | undefined {
  try {
    const parsedURL = new URL(input);
    return getGitHubPathFromURL(parsedURL, githubHost);
  } catch {
    return undefined;
  }
}
