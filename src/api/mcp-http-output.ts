import { ServiceError } from '../services/errors.js';
/** Compact incremental preparation bounds protocol-escaped text before allocating a whole result. */
export function boundedJsonText(value: unknown, maxBytes: number): string {
  const chunks: string[] = [];
  let bytes = 512; // JSON-RPC/content wrapper and request ID allowance.
  const append = (text: string) => {
    if (Buffer.byteLength(text) > maxBytes) throw oversized();
    bytes += Buffer.byteLength(JSON.stringify(text)) - 2;
    if (bytes > maxBytes) throw oversized();
    chunks.push(text);
  };
  const stack: Array<{ value?: unknown; text?: string }> = [{ value }];
  const ancestors = new Set<object>();
  const closes: Array<{ object: object; index: number }> = [];
  while (stack.length) {
    const task = stack.pop()!;
    while (closes.length && closes[closes.length - 1].index === stack.length + 1) ancestors.delete(closes.pop()!.object);
    if (task.text !== undefined) { append(task.text); continue; }
    const current = task.value;
    if (current === null || current === undefined || typeof current === 'function' || typeof current === 'symbol') { append('null'); continue; }
    if (typeof current === 'string') { if (Buffer.byteLength(current) > maxBytes) throw oversized(); append(JSON.stringify(current)); continue; }
    if (typeof current === 'number' || typeof current === 'boolean') { append(JSON.stringify(current)); continue; }
    if (typeof current === 'bigint') throw new TypeError('Unsupported JSON value');
    if (current instanceof Date) { append(JSON.stringify(current)); continue; }
    if (typeof current !== 'object') throw new TypeError('Unsupported JSON value');
    if (ancestors.has(current)) throw new TypeError('Circular JSON value');
    ancestors.add(current);
    const before = stack.length;
    if (Array.isArray(current)) {
      append('['); stack.push({ text: ']' });
      for (let index = current.length - 1; index >= 0; index--) {
        stack.push({ value: current[index] }); if (index) stack.push({ text: ',' });
      }
    } else {
      append('{'); stack.push({ text: '}' });
      const entries = Object.entries(current).filter(([, value]) => value !== undefined && typeof value !== 'function' && typeof value !== 'symbol');
      for (let index = entries.length - 1; index >= 0; index--) {
        const [key, value] = entries[index]; stack.push({ value }); stack.push({ text: ':' });
        stack.push({ value: key }); if (index) stack.push({ text: ',' });
      }
    }
    closes.push({ object: current, index: before + 1 });
  }
  return chunks.join('');
}
function oversized(): ServiceError { return new ServiceError('PAYLOAD_TOO_LARGE', 'Authorized result exceeds the response size limit'); }
