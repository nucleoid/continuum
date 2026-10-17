import { describe, expect, it } from 'vitest';
import { boundedJsonText } from './mcp-http-output.js';
describe('bounded remote JSON preparation', () => {
  it('keeps deep metadata compact within the wire budget without pretty indentation expansion', () => {
    let nested: unknown = 'leaf';
    for (let index = 0; index < 200; index++) nested = { nested };
    expect(Buffer.byteLength(JSON.stringify(nested, null, 2))).toBeGreaterThan(50000);
    expect(JSON.parse(boundedJsonText(nested, 5000))).toEqual(nested);
  });
  it('rejects control-character expansion and aggregate text before whole-result allocation', () => {
    expect(() => boundedJsonText(['\u0001'.repeat(200)], 1000)).toThrow('response size limit');
    expect(() => boundedJsonText(Array(50).fill('x'.repeat(100)), 1000)).toThrow('response size limit');
  });
  it('preserves JSON scalar, array, date and object semantics', () => {
    const value = { date: new Date(0), number: NaN, ignored: undefined, array: [undefined, true], text: '\n"' };
    expect(boundedJsonText(value, 5000)).toBe(JSON.stringify(value));
  });
});
