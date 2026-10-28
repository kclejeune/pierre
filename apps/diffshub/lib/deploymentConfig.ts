// Every process-wide configuration check in one call, so the health probe and
// the startup banner cannot drift apart when a new settings area is added.

import { validateGitHubConfiguration } from './githubEnvironment';
import { validatePreferenceStoreConfiguration } from './preferenceStore';

export function validateDeploymentConfiguration(): void {
  validateGitHubConfiguration();
  validatePreferenceStoreConfiguration();
}
