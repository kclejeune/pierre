const stringDetachEncoder = new TextEncoder();
const stringDetachDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
// A surrogate code unit outside a valid high+low pair. Paired surrogates
// (emoji) round-trip losslessly through TextEncoder/TextDecoder, so only
// genuinely ill-formed input needs the slower JSON path.
const LONE_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const STRING_DETACH_INITIAL_BUFFER_SIZE = 1024;
let stringDetachBuffer = new Uint8Array(STRING_DETACH_INITIAL_BUFFER_SIZE);

// Drops the reusable scratch buffer after a parsing run so one unusually large
// input does not pin that peak allocation for the lifetime of the process.
export function releaseStringDetachBuffer(): void {
  if (stringDetachBuffer.length !== STRING_DETACH_INITIAL_BUFFER_SIZE) {
    stringDetachBuffer = new Uint8Array(STRING_DETACH_INITIAL_BUFFER_SIZE);
  }
}

// Forces a fresh backing string so a retained substring does not keep the
// original raw patch/file text alive.
export function detachString(value: string): string {
  if (value.length === 0) {
    return value;
  }

  // TextEncoder replaces lone surrogate code units with U+FFFD, but diff input
  // can contain arbitrary text. JSON round-tripping preserves those code units
  // while still forcing V8 to allocate a fresh backing string.
  if (LONE_SURROGATE_PATTERN.test(value)) {
    return JSON.parse(JSON.stringify(value)) as string;
  }

  // Encode into a reusable scratch buffer, then decode only the written bytes
  // so the result is a compact, freshly allocated string. The buffer is sized
  // for the common case (one byte per code unit) rather than the 3-byte UTF-8
  // worst case, and grows only when the input turns out to need more: inputs
  // are now whole files, and a 3x scratch for a multi-megabyte file would be a
  // large transient allocation for text that is almost always ASCII.
  if (stringDetachBuffer.length < value.length) {
    stringDetachBuffer = new Uint8Array(value.length);
  }
  const first = stringDetachEncoder.encodeInto(value, stringDetachBuffer);
  let written = first.written;
  if (first.read < value.length) {
    // The optimistic buffer ran out. Remaining code units encode to at most 3
    // bytes each (encodeInto never stops mid-code-point, so the slice below
    // starts on a boundary), meaning one exact-worst-case growth always
    // finishes the encode.
    const grown = new Uint8Array(written + (value.length - first.read) * 3);
    grown.set(stringDetachBuffer.subarray(0, written));
    stringDetachBuffer = grown;
    written += stringDetachEncoder.encodeInto(
      value.slice(first.read),
      grown.subarray(written)
    ).written;
  }
  return stringDetachDecoder.decode(stringDetachBuffer.subarray(0, written));
}
