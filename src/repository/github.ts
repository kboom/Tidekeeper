import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  AuthenticationError,
  ConflictError,
  NetworkError,
  ValidationError,
} from '../errors.js';

const execFileAsync = promisify(execFile);

export type GitHubRepositoryVisibility = 'private' | 'public';

export type GitHubRepositoryPublishOptions = {
  repositoryName?: string | undefined;
  root: string;
  visibility?: GitHubRepositoryVisibility | undefined;
};

export type GitHubRepositoryPublishResult = {
  owner: string;
  repository: string;
  status: 'published';
  url: string;
  visibility: GitHubRepositoryVisibility;
};

export type GitHubCommandExecutor = (
  command: string,
  args: readonly string[],
) => Promise<string>;

export type GitHubRepositoryPublishDependencies = {
  execute(command: string, args: readonly string[]): Promise<string>;
};

type ExistingGitHubRepository = {
  isEmpty: boolean;
  nameWithOwner: string;
  url: string;
  visibility: GitHubRepositoryVisibility;
};

export async function publishGitHubRepository(
  options: GitHubRepositoryPublishOptions,
  dependencies: GitHubRepositoryPublishDependencies = {
    execute: executeCommand,
  },
): Promise<GitHubRepositoryPublishResult> {
  const repositoryName = options.repositoryName ?? 'Tidal';
  const visibility = options.visibility ?? 'private';
  validateRepositoryName(repositoryName);
  await assertGitRepository(options.root, dependencies);

  const owner = await getGitHubOwner(dependencies);
  const repository = `${owner}/${repositoryName}`;
  const expectedRemote = repository.toLowerCase();
  const origin = await getOrigin(options.root, dependencies);
  if (
    origin !== undefined &&
    normalizeGitHubRepository(origin) !== expectedRemote
  ) {
    throw new ConflictError(
      `Git remote "origin" points to ${origin}, not ${repository}. Refusing to replace it.`,
    );
  }

  let remote = await getGitHubRepository(owner, repositoryName, dependencies);
  if (remote === null) {
    try {
      await dependencies.execute('gh', [
        'repo',
        'create',
        repository,
        visibility === 'private' ? '--private' : '--public',
      ]);
    } catch (error: unknown) {
      remote = await getGitHubRepository(owner, repositoryName, dependencies);
      if (remote === null) {
        throw new NetworkError(
          `Unable to create GitHub repository ${repository}.`,
          { cause: error },
        );
      }
    }
  }

  if (remote !== null) {
    if (remote.visibility !== visibility) {
      throw new ConflictError(
        `GitHub repository ${repository} already exists with ${remote.visibility} visibility; requested ${visibility}.`,
      );
    }
    if (origin === undefined && !remote.isEmpty) {
      throw new ConflictError(
        `GitHub repository ${repository} already contains commits. Refusing to attach it to this local repository.`,
      );
    }
  }

  const url = remote?.url ?? `https://github.com/${repository}`;
  if (origin === undefined) {
    await runGit(
      options.root,
      ['remote', 'add', 'origin', `${url}.git`],
      dependencies,
      `Unable to configure Git remote "origin" for ${repository}.`,
    );
  }

  try {
    await dependencies.execute('git', [
      '-C',
      options.root,
      'push',
      '--set-upstream',
      'origin',
      'HEAD',
    ]);
  } catch (error: unknown) {
    throw new NetworkError(
      `GitHub repository ${repository} is ready, but the initial push failed. Retry with: tidekeeper --root ${JSON.stringify(options.root)} repo publish --github-repo ${JSON.stringify(repositoryName)} --github-visibility ${visibility}`,
      { cause: error },
    );
  }

  return {
    owner,
    repository,
    status: 'published',
    url,
    visibility,
  };
}

async function assertGitRepository(
  root: string,
  dependencies: GitHubRepositoryPublishDependencies,
): Promise<void> {
  const result = await runGit(
    root,
    ['rev-parse', '--is-inside-work-tree'],
    dependencies,
    `${root} is not a Git worktree.`,
  );
  if (result.trim() !== 'true') {
    throw new ValidationError(`${root} is not a Git worktree.`);
  }
}

async function getGitHubOwner(
  dependencies: GitHubRepositoryPublishDependencies,
): Promise<string> {
  let owner: string;
  try {
    owner = (
      await dependencies.execute('gh', ['api', 'user', '--jq', '.login'])
    ).trim();
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      throw new ValidationError(
        'GitHub CLI is required for repository publishing. Install "gh" and authenticate it first.',
        { cause: error },
      );
    }
    throw new AuthenticationError(
      'GitHub CLI is not authenticated. Run "gh auth login --hostname github.com" and retry.',
      { cause: error },
    );
  }
  if (!owner) {
    throw new AuthenticationError(
      'GitHub CLI did not return an authenticated personal account.',
    );
  }
  return owner;
}

async function getOrigin(
  root: string,
  dependencies: GitHubRepositoryPublishDependencies,
): Promise<string | undefined> {
  const remotes = (
    await runGit(
      root,
      ['remote'],
      dependencies,
      'Unable to inspect Git remotes.',
    )
  )
    .split(/\r?\n/u)
    .filter(Boolean);
  if (!remotes.includes('origin')) {
    return undefined;
  }
  return (
    await runGit(
      root,
      ['remote', 'get-url', 'origin'],
      dependencies,
      'Unable to inspect Git remote "origin".',
    )
  ).trim();
}

async function getGitHubRepository(
  owner: string,
  repositoryName: string,
  dependencies: GitHubRepositoryPublishDependencies,
): Promise<ExistingGitHubRepository | null> {
  let output: string;
  try {
    output = await dependencies.execute('gh', [
      'repo',
      'list',
      owner,
      '--limit',
      '1000',
      '--json',
      'isEmpty,nameWithOwner,url,visibility',
    ]);
  } catch (error: unknown) {
    throw new NetworkError(
      `Unable to inspect GitHub repository ${owner}/${repositoryName}.`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error: unknown) {
    throw new ValidationError(
      'GitHub CLI returned malformed repository data.',
      {
        cause: error,
      },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ValidationError('GitHub CLI returned malformed repository data.');
  }
  const repositories: readonly unknown[] = parsed;
  const expectedName = `${owner}/${repositoryName}`.toLowerCase();
  const repository: unknown = repositories.find(
    (candidate: unknown) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      'nameWithOwner' in candidate &&
      typeof candidate.nameWithOwner === 'string' &&
      candidate.nameWithOwner.toLowerCase() === expectedName,
  );
  if (repository === undefined) {
    return null;
  }
  if (
    typeof repository !== 'object' ||
    repository === null ||
    !('isEmpty' in repository) ||
    !('nameWithOwner' in repository) ||
    !('url' in repository) ||
    !('visibility' in repository) ||
    typeof repository.isEmpty !== 'boolean' ||
    typeof repository.nameWithOwner !== 'string' ||
    typeof repository.url !== 'string' ||
    (repository.visibility !== 'PRIVATE' && repository.visibility !== 'PUBLIC')
  ) {
    throw new ValidationError('GitHub CLI returned malformed repository data.');
  }
  return {
    isEmpty: repository.isEmpty,
    nameWithOwner: repository.nameWithOwner,
    url: repository.url,
    visibility:
      repository.visibility.toLowerCase() as GitHubRepositoryVisibility,
  };
}

async function runGit(
  root: string,
  args: readonly string[],
  dependencies: GitHubRepositoryPublishDependencies,
  message: string,
): Promise<string> {
  try {
    return await dependencies.execute('git', ['-C', root, ...args]);
  } catch (error: unknown) {
    throw new ValidationError(message, { cause: error });
  }
}

function validateRepositoryName(repositoryName: string): void {
  if (
    repositoryName.trim() !== repositoryName ||
    repositoryName.length === 0 ||
    repositoryName.length > 100 ||
    repositoryName.includes('/') ||
    !/^[A-Za-z0-9._-]+$/u.test(repositoryName)
  ) {
    throw new ValidationError(
      'GitHub repository name must be 1-100 characters using letters, numbers, ".", "_", or "-".',
    );
  }
}

function normalizeGitHubRepository(remote: string): string | undefined {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/iu.exec(
      remote.trim(),
    );
  return match?.[1]?.toLowerCase();
}

async function executeCommand(
  command: string,
  args: readonly string[],
): Promise<string> {
  const { stdout } = await execFileAsync(command, [...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return stdout;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
