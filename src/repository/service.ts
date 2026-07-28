import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { getAuthStatus, login, type AuthStatus } from '../auth/service.js';
import { MemoryStorageAdapter } from '../auth/storage.js';
import type { LibrarySnapshot, TidekeeperConfig } from '../domain.js';
import { ConflictError, ValidationError } from '../errors.js';
import {
  initializeLibrary,
  loadLibrary,
  writeLibrarySnapshot,
} from '../storage/library.js';
import { ensureDirectory, writeTextFileAtomic } from '../storage/yaml.js';
import { getRemoteSnapshot } from '../tidal/snapshot.js';
import { createAuthenticatedTidalClient } from '../tidal/authenticated.js';
import {
  contentHash,
  createTemplateManifest,
  getRepositoryTemplateAssets,
  type RepositoryTemplateManifest,
} from './template.js';
import {
  publishGitHubRepository,
  type GitHubRepositoryPublishOptions,
  type GitHubRepositoryPublishResult,
  type GitHubRepositoryVisibility,
} from './github.js';

const execFileAsync = promisify(execFile);
const manifestFileName = '.tidekeeper-template.json';
const runtimeLauncherFileName = 'run-tidekeeper.mjs';

export type RepositoryCreateOptions = {
  countryCode: string;
  ephemeralSession?: boolean | undefined;
  gitEmail?: string | undefined;
  gitName?: string | undefined;
  github?: boolean | undefined;
  githubRepository?: string | undefined;
  githubVisibility?: GitHubRepositoryVisibility | undefined;
  target: string;
};

export type RepositoryCreateDependencies = {
  authStatus(): Promise<AuthStatus>;
  login(): Promise<AuthStatus>;
  publish(
    options: GitHubRepositoryPublishOptions,
  ): Promise<GitHubRepositoryPublishResult>;
  remoteSnapshot(config: TidekeeperConfig): Promise<LibrarySnapshot>;
};

export type RepositoryCreateResult = {
  favoriteTracks: number;
  githubRepository: string | null;
  githubUrl: string | null;
  githubVisibility: GitHubRepositoryVisibility | null;
  playlists: number;
  status: 'created';
  target: string;
  tracksInPlaylists: number;
};

export type RepositoryVerifyResult = {
  favoriteTracks: number;
  generatedFiles: number;
  playlists: number;
  status: 'valid';
  tracksInPlaylists: number;
};

export async function createRepository(
  options: RepositoryCreateOptions,
  dependencies?: RepositoryCreateDependencies,
): Promise<RepositoryCreateResult> {
  const activeDependencies =
    dependencies ??
    createDefaultDependencies(options.ephemeralSession === true);
  const target = resolve(options.target);
  validateCreateOptions(options, target);
  await assertTargetAbsent(target);
  await assertGitIdentity(options);

  const status = await activeDependencies.authStatus();
  if (!status.authenticated) {
    const loggedIn = await activeDependencies.login();
    if (!loggedIn.authenticated) {
      throw new ValidationError(
        'TIDAL login did not produce an authenticated session.',
      );
    }
  }

  const staging = join(
    dirname(target),
    `.${basename(target)}.tidekeeper-staging-${randomUUID()}`,
  );
  await mkdir(staging, { recursive: false });
  try {
    await renderRepositoryTemplate(staging);
    await initializeLibrary(staging, options.countryCode);
    await initializeGitRepository(staging, options);
    await git(staging, ['add', '--', '.']);
    await git(staging, [
      'commit',
      '-m',
      'Initialize Tidekeeper music repository',
    ]);

    const local = await loadLibrary(staging);
    const remote = await activeDependencies.remoteSnapshot(local.config);
    await writeLibrarySnapshot(staging, remote);
    await writeImportReceipt(staging, remote);
    await verifyRepository(staging);
    await git(staging, [
      'add',
      '--',
      'tidekeeper.yaml',
      'library',
      '.tidekeeper-import.json',
    ]);
    await git(staging, ['commit', '-m', 'Import TIDAL music library']);
    await assertCleanWorktree(staging);
    await rename(staging, target);

    const github =
      options.github === false
        ? undefined
        : await activeDependencies.publish({
            repositoryName: options.githubRepository ?? 'Tidal',
            root: target,
            visibility: options.githubVisibility ?? 'private',
          });
    return createResult(target, remote, github);
  } catch (error: unknown) {
    await rm(staging, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }

  function createDefaultDependencies(
    ephemeralSession: boolean,
  ): RepositoryCreateDependencies {
    if (!ephemeralSession) {
      return {
        authStatus: getAuthStatus,
        login: () => login(),
        publish: publishGitHubRepository,
        remoteSnapshot: async (config) =>
          getRemoteSnapshot(await createAuthenticatedTidalClient(), config),
      };
    }

    const storage = new MemoryStorageAdapter();
    return {
      authStatus: () => getAuthStatus(storage),
      login: () => login({ storage }),
      publish: publishGitHubRepository,
      remoteSnapshot: async (config) =>
        getRemoteSnapshot(
          await createAuthenticatedTidalClient(storage),
          config,
        ),
    };
  }
}

export async function verifyRepository(
  root: string,
): Promise<RepositoryVerifyResult> {
  const repositoryRoot = resolve(root);
  await assertGitWorktree(repositoryRoot);
  const manifest = await readManifest(repositoryRoot);
  const expected = createTemplateManifest();
  if (manifest.templateVersion !== expected.templateVersion) {
    throw new ValidationError(
      `Unsupported Tidekeeper repository template version: ${manifest.templateVersion}.`,
    );
  }

  for (const [path, expectedHash] of Object.entries(manifest.generatedFiles)) {
    const source = getRepositoryTemplateAssets().find(
      (asset) => asset.owner === 'generated' && asset.path === path,
    );
    if (!source || expected.generatedFiles[path] !== expectedHash) {
      throw new ValidationError(
        `Generated file ${path} does not belong to this Tidekeeper template version.`,
      );
    }
    const text = await readRequiredFile(join(repositoryRoot, path));
    if (contentHash(text) !== expectedHash) {
      throw new ValidationError(
        `Generated file ${path} was modified. Restore it or resolve the template upgrade.`,
      );
    }
  }

  const gitignore = await readRequiredFile(join(repositoryRoot, '.gitignore'));
  for (const ignoredPath of [
    '.tidekeeper/',
    '.env',
    '.env.*',
    'node_modules/',
  ]) {
    if (!gitignore.includes(ignoredPath)) {
      throw new ValidationError(`.gitignore must ignore ${ignoredPath}.`);
    }
  }
  await assertRuntimeLauncher(repositoryRoot);

  const library = await loadLibrary(repositoryRoot);
  return {
    favoriteTracks: library.favorites.tracks.length,
    generatedFiles: Object.keys(manifest.generatedFiles).length,
    playlists: library.playlists.length,
    status: 'valid',
    tracksInPlaylists: library.playlists.reduce(
      (count, playlist) => count + playlist.tracks.length,
      0,
    ),
  };
}

export async function upgradeRepository(
  root: string,
): Promise<RepositoryVerifyResult> {
  const repositoryRoot = resolve(root);
  const manifest = await readManifest(repositoryRoot);
  for (const [path, expectedHash] of Object.entries(manifest.generatedFiles)) {
    const text = await readRequiredFile(join(repositoryRoot, path));
    if (contentHash(text) !== expectedHash) {
      throw new ConflictError(
        `Cannot upgrade because generated file ${path} has local modifications.`,
      );
    }
  }
  await renderRepositoryTemplate(repositoryRoot, true);
  return verifyRepository(repositoryRoot);
}

async function renderRepositoryTemplate(
  root: string,
  preserveUserFiles = false,
): Promise<void> {
  for (const asset of getRepositoryTemplateAssets()) {
    const path = join(root, asset.path);
    if (preserveUserFiles && asset.owner === 'user' && (await exists(path))) {
      continue;
    }
    await writeTextFileAtomic(path, asset.content);
  }
  await writeRuntimeLauncher(root);
  const manifest: RepositoryTemplateManifest = createTemplateManifest();
  await writeTextFileAtomic(
    join(root, manifestFileName),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function writeRuntimeLauncher(root: string): Promise<void> {
  const runtimeRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
  );
  const executable = join(runtimeRoot, 'dist', 'index.js');
  await writeTextFileAtomic(
    join(root, '.tidekeeper', runtimeLauncherFileName),
    createRuntimeLauncher(executable),
  );
}

function createRuntimeLauncher(executable: string): string {
  return `import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = ${JSON.stringify(executable)};
const child = spawn(process.execPath, [executable, '--root', repositoryRoot, ...process.argv.slice(2)], {
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});

child.once('error', (error) => {
  console.error(\`Unable to start the attached Tidekeeper runtime: \${error.message}\`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
`;
}

async function assertRuntimeLauncher(root: string): Promise<void> {
  const launcherPath = join(root, '.tidekeeper', runtimeLauncherFileName);
  const launcher = await readRequiredFile(launcherPath);
  const executableMatch = /^const executable = ("(?:[^"\\]|\\.)*");$/mu.exec(
    launcher,
  );
  if (!executableMatch?.[1]) {
    throw new ValidationError(
      'The attached Tidekeeper runtime launcher is malformed. Run "repo upgrade" from the Tidekeeper source checkout.',
    );
  }
  let executable: string;
  try {
    executable = JSON.parse(executableMatch[1]) as string;
  } catch (error: unknown) {
    throw new ValidationError(
      'The attached Tidekeeper runtime launcher is malformed.',
      { cause: error },
    );
  }
  try {
    await lstat(executable);
  } catch (error: unknown) {
    throw new ValidationError(
      'The attached Tidekeeper runtime is unavailable. Run "repo upgrade" from the Tidekeeper source checkout.',
      { cause: error },
    );
  }
}

async function writeImportReceipt(
  root: string,
  snapshot: LibrarySnapshot,
): Promise<void> {
  const receipt = {
    favoriteTracks: snapshot.favorites.tracks.length,
    libraryFingerprint: contentHash(JSON.stringify(snapshot)),
    playlists: snapshot.playlists.length,
    schemaVersion: 1,
    tracksInPlaylists: snapshot.playlists.reduce(
      (count, playlist) => count + playlist.tracks.length,
      0,
    ),
  };
  await writeTextFileAtomic(
    join(root, '.tidekeeper-import.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}

function validateCreateOptions(
  options: RepositoryCreateOptions,
  target: string,
): void {
  if (!/^[A-Z]{2}$/u.test(options.countryCode)) {
    throw new ValidationError(
      'countryCode must be an ISO 3166-1 alpha-2 country code.',
    );
  }
  if (target === dirname(target) || basename(target) === '.') {
    throw new ValidationError('Repository target must name a new directory.');
  }
  if (
    (options.gitName === undefined) !== (options.gitEmail === undefined) ||
    options.gitName?.trim() === '' ||
    options.gitEmail?.trim() === ''
  ) {
    throw new ValidationError(
      '--git-name and --git-email must be provided together and be non-empty.',
    );
  }
}

async function assertTargetAbsent(target: string): Promise<void> {
  try {
    await lstat(target);
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      await ensureDirectory(dirname(target));
      return;
    }
    throw new ValidationError(
      `Unable to inspect repository target ${target}.`,
      {
        cause: error,
      },
    );
  }
  throw new ConflictError(
    `Repository target already exists: ${target}. Refusing to overwrite it.`,
  );
}

async function assertGitIdentity(
  options: RepositoryCreateOptions,
): Promise<void> {
  if (options.gitName !== undefined && options.gitEmail !== undefined) {
    return;
  }
  try {
    const [name, email] = await Promise.all([
      git(process.cwd(), ['config', '--get', 'user.name']),
      git(process.cwd(), ['config', '--get', 'user.email']),
    ]);
    if (!name.trim() || !email.trim()) {
      throw new Error('Git identity is incomplete.');
    }
  } catch (error: unknown) {
    throw new ValidationError(
      'Git user.name and user.email are required. Configure Git or pass --git-name and --git-email.',
      { cause: error },
    );
  }
}

async function initializeGitRepository(
  root: string,
  options: RepositoryCreateOptions,
): Promise<void> {
  await git(root, ['init']);
  if (options.gitName !== undefined && options.gitEmail !== undefined) {
    await git(root, ['config', 'user.name', options.gitName]);
    await git(root, ['config', 'user.email', options.gitEmail]);
  }
}

async function assertGitWorktree(root: string): Promise<void> {
  const inside = await git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside.trim() !== 'true') {
    throw new ValidationError(`${root} is not a Git worktree.`);
  }
}

async function assertCleanWorktree(root: string): Promise<void> {
  const status = await git(root, [
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);
  if (status.trim()) {
    throw new ValidationError(
      'Generated repository has unexpected uncommitted files after initialization.',
    );
  }
}

async function readManifest(root: string): Promise<RepositoryTemplateManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readRequiredFile(join(root, manifestFileName)));
  } catch (error: unknown) {
    throw new ValidationError(
      'Invalid Tidekeeper repository template manifest.',
      {
        cause: error,
      },
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('templateVersion' in parsed) ||
    !('generatedFiles' in parsed) ||
    typeof parsed.templateVersion !== 'number' ||
    typeof parsed.generatedFiles !== 'object' ||
    parsed.generatedFiles === null ||
    Object.values(parsed.generatedFiles).some(
      (hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash),
    )
  ) {
    throw new ValidationError(
      'Invalid Tidekeeper repository template manifest.',
    );
  }
  return parsed as RepositoryTemplateManifest;
}

async function readRequiredFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error: unknown) {
    throw new ValidationError(`Required repository file is missing: ${path}.`, {
      cause: error,
    });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

async function git(root: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return stdout;
  } catch (error: unknown) {
    throw new ValidationError(`Git command failed: git ${args.join(' ')}.`, {
      cause: error,
    });
  }
}

function createResult(
  target: string,
  snapshot: LibrarySnapshot,
  github?: GitHubRepositoryPublishResult,
): RepositoryCreateResult {
  return {
    favoriteTracks: snapshot.favorites.tracks.length,
    githubRepository: github?.repository ?? null,
    githubUrl: github?.url ?? null,
    githubVisibility: github?.visibility ?? null,
    playlists: snapshot.playlists.length,
    status: 'created',
    target,
    tracksInPlaylists: snapshot.playlists.reduce(
      (count, playlist) => count + playlist.tracks.length,
      0,
    ),
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
