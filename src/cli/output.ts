function safe(value: unknown): string {
  if (value === null || value === undefined) return '-';
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() || '-';
}

export function jsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function table(headers: string[], rows: unknown[][]): string {
  const normalized = rows.map((row) => row.map(safe));
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...normalized.map((row) => (row[index] ?? '').length),
  ));
  const line = (cells: string[]) => cells
    .map((cell, index) => cell.padEnd(widths[index]))
    .join('  ')
    .trimEnd();
  return `${line(headers)}\n${line(widths.map((width) => '-'.repeat(width)))}\n${normalized.map(line).join('\n')}${normalized.length ? '\n' : ''}`;
}
