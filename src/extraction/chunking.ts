import { createHash } from 'node:crypto';

export interface ExtractionChunk {
  id: string; sourceFamily: string; index: number; start: number; end: number; hash: string; text: string;
}
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Offsets address the exact UTF-8 canonical evidence payload, without overlap.
 * Preflight all bounds before returning a partial set of chunks. */
export function chunkSource(version: string, text: string, maxBytes: number, maxChunks: number): ExtractionChunk[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > 65_536
    || !Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > 64
    || text !== Buffer.from(text, 'utf8').toString('utf8')) throw new TypeError('Invalid extraction chunk bounds');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > maxBytes * maxChunks) throw new RangeError('Extraction chunk bounds exceeded');
  const result: ExtractionChunk[] = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + maxBytes, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    if (result.length === maxChunks) throw new RangeError('Extraction chunk bounds exceeded');
    const part = bytes.subarray(start, end), digest = hash(part);
    result.push(Object.freeze({ id: hash(`${version}:${start}:${end}:${digest}`), sourceFamily: version,
      index: result.length, start, end, hash: digest, text: part.toString('utf8') }));
    start = end;
  }
  return result;
}
