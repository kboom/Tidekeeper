import {
  open,
  readFile,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { ConflictError } from '../errors.js';
import { ensureDirectory } from '../storage/yaml.js';

const incompleteLockStaleAfterMs = 30_000;

export async function withSyncLock<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = join(resolve(root), '.tidekeeper', 'sync.lock');
  const handle = await acquireLock(lockPath);
  try {
    return await operation();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

async function acquireLock(lockPath: string): Promise<FileHandle> {
  await ensureDirectory(dirname(lockPath));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            startedAt: new Date().toISOString(),
          }),
        );
        return handle;
      } catch (error: unknown) {
        await handle.close();
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
    } catch (error: unknown) {
      if (!isAlreadyExistsError(error) || !(await removeStaleLock(lockPath))) {
        throw new ConflictError(
          'Another Tidekeeper synchronization is already running for this library.',
          { cause: error },
        );
      }
    }
  }
  throw new ConflictError(
    'Another Tidekeeper synchronization is already running for this library.',
  );
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(lockPath, 'utf8')) as {
      pid?: unknown;
    };
    if (
      typeof owner.pid === 'number' &&
      Number.isInteger(owner.pid) &&
      owner.pid > 0
    ) {
      if (isProcessAlive(owner.pid)) {
        return false;
      }
      await unlink(lockPath);
      return true;
    }
  } catch {
    // A process can exit between creating the lock and recording its owner.
  }

  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs < incompleteLockStaleAfterMs) {
      return false;
    }
    await unlink(lockPath);
    return true;
  } catch {
    return true;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !isNoSuchProcessError(error);
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return hasErrorCode(error, 'EEXIST');
}

function isNoSuchProcessError(error: unknown): boolean {
  return hasErrorCode(error, 'ESRCH');
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
