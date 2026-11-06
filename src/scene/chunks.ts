export const CHUNK_BYTES = 1000;

/**
 * Splits a text into chunks of at most `max` UTF-8 bytes: each chunk is the longest prefix of the rest that fits
 * without splitting a character. An empty text is one empty chunk.
 */
export function chunk(text: string, max = CHUNK_BYTES): string[] {
  const out: string[] = [];
  let start = 0;
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.codePointAt(i)!;
    const len = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    const units = c >= 0x10000 ? 2 : 1;
    if (bytes + len > max) {
      out.push(text.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += len;
    i += units;
  }
  if (start < text.length || out.length === 0) out.push(text.slice(start));
  return out;
}

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}
