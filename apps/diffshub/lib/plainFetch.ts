// `fetch` as a plain call signature. Bun's `typeof fetch` carries namespace
// extras like `preconnect`, so a test stub typed against it fails to compile;
// modules that accept an injectable fetch take this instead.
export type PlainFetch = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
) => ReturnType<typeof fetch>;
