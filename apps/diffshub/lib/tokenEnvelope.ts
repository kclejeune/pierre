// Shared envelope identification for the browser and server. Keep this small:
// client-side migration checks need the wire-format discriminator without
// pulling the server-only Web Crypto and Buffer implementation into the bundle.
export const SEALED_TOKEN_PREFIX = 'dhe1';

export function isSealedToken(value: string): boolean {
  return value.startsWith(`${SEALED_TOKEN_PREFIX}.`);
}
