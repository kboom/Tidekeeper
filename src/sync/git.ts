import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ConflictError } from '../errors.js';

const execFileAsync = promisify(execFile);

export async function assertManagedFilesClean(
  root: string,
  operation: 'pull' | 'push',
  libraryDirectory = 'library',
): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      'git',
      [
        '-C',
        root,
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--',
        'tidekeeper.yaml',
        libraryDirectory,
      ],
      { encoding: 'utf8', windowsHide: true },
    ));
  } catch (error: unknown) {
    throw new ConflictError(
      `Cannot apply sync ${operation}: ${root} is not an accessible Git worktree.`,
      { cause: error },
    );
  }

  if (stdout.trim()) {
    throw new ConflictError(
      `Cannot apply sync ${operation}: managed files have uncommitted changes.`,
    );
  }
}
