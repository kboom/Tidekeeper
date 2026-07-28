import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseDocument, stringify } from 'yaml';
import type { z } from 'zod';

import { ValidationError } from '../errors.js';

const conflictMarkerPattern = /^(?:<{7}|={7}|>{7})(?: .*)?$/m;

export async function readYamlFile<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error: unknown) {
    throw new ValidationError(`Unable to read ${path}.`, { cause: error });
  }

  if (conflictMarkerPattern.test(text)) {
    throw new ValidationError(
      `${path} contains unresolved Git conflict markers.`,
    );
  }

  const document = parseDocument(text, {
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new ValidationError(
      `Invalid YAML in ${path}: ${document.errors.map((error) => error.message).join('; ')}`,
    );
  }

  const result = schema.safeParse(document.toJS({ maxAliasCount: 0 }));
  if (!result.success) {
    throw new ValidationError(
      `Invalid Tidekeeper data in ${path}: ${formatIssues(result.error.issues)}`,
    );
  }
  return result.data;
}

export function serializeYaml<T>(value: T, schema: z.ZodType<T>): string {
  const parsed = validateValue(value, schema);
  return stringify(parsed, {
    aliasDuplicateObjects: false,
    lineWidth: 0,
    sortMapEntries: false,
  });
}

export function validateValue<T>(value: unknown, schema: z.ZodType<T>): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(
      `Invalid Tidekeeper data: ${formatIssues(result.error.issues)}`,
    );
  }
  return result.data;
}

export async function writeYamlFileAtomic<T>(
  path: string,
  value: T,
  schema: z.ZodType<T>,
): Promise<void> {
  const text = serializeYaml(value, schema);
  await writeTextFileAtomic(path, text);
}

export async function writeTextFileAtomic(
  path: string,
  text: string,
): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await ensureDirectory(dirname(path));
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new ValidationError(`Unable to atomically write ${path}.`, {
      cause: error,
    });
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  try {
    const details = await stat(path);
    if (!details.isDirectory()) {
      throw new ValidationError(`${path} is not a directory.`);
    }
    return;
  } catch (error: unknown) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error;
    }
  }
  await mkdir(path, { recursive: true });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}
