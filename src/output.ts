import type { Writable } from 'node:stream';

import { ValidationError } from './errors.js';

export const OutputFormat = {
  json: 'json',
  jsonl: 'jsonl',
  table: 'table',
} as const;

export type OutputFormatValue =
  (typeof OutputFormat)[keyof typeof OutputFormat];

export type OutputStreams = {
  stderr: Writable;
  stdout: Writable;
};

export const defaultStreams: OutputStreams = {
  stderr: process.stderr,
  stdout: process.stdout,
};

export function writeJson(stream: Writable, value: unknown): void {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeJsonLines(
  stream: Writable,
  values: readonly unknown[],
): void {
  for (const value of values) {
    stream.write(`${JSON.stringify(value)}\n`);
  }
}

export function writeDiagnostic(stream: Writable, message: string): void {
  stream.write(`${message}\n`);
}

export function writeTable(
  stream: Writable,
  rows: readonly Record<string, string | number | boolean | null>[],
): void {
  if (rows.length === 0) {
    return;
  }

  const firstRow = rows[0];
  if (!firstRow) {
    return;
  }
  const columns = Object.keys(firstRow);
  const widths = columns.map((column) =>
    Math.max(
      column.length,
      ...rows.map((row) => formatCell(row[column]).length),
    ),
  );
  const renderRow = (row: Record<string, string | number | boolean | null>) =>
    columns
      .map((column, index) =>
        formatCell(row[column]).padEnd(widths[index] ?? 0),
      )
      .join('  ')
      .trimEnd();

  stream.write(
    `${renderRow(Object.fromEntries(columns.map((c) => [c, c])))}\n`,
  );
  stream.write(`${widths.map((width) => '-'.repeat(width)).join('  ')}\n`);
  for (const row of rows) {
    stream.write(`${renderRow(row)}\n`);
  }
}

export function parseOutputFormat(
  value: string,
  allowed: readonly OutputFormatValue[] = Object.values(OutputFormat),
): OutputFormatValue {
  if (!allowed.includes(value as OutputFormatValue)) {
    throw new ValidationError(
      `Invalid output format "${value}". Expected one of: ${allowed.join(', ')}.`,
    );
  }
  return value as OutputFormatValue;
}

export function writeOutput(
  stream: Writable,
  format: OutputFormatValue,
  value: unknown,
  rows: readonly Record<string, string | number | boolean | null>[],
): void {
  if (format === OutputFormat.json) {
    writeJson(stream, value);
    return;
  }
  if (format === OutputFormat.jsonl) {
    writeJsonLines(stream, Array.isArray(value) ? value : [value]);
    return;
  }
  writeTable(stream, rows);
}

function formatCell(
  value: string | number | boolean | null | undefined,
): string {
  return value === null || value === undefined ? '' : String(value);
}
