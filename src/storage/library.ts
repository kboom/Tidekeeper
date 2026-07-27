import { randomUUID } from 'node:crypto';
import { mkdir, realpath, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import type {
  FavoritesDocument,
  LibrarySnapshot,
  PlaylistDocument,
  TidekeeperConfig,
} from '../domain.js';
import { ValidationError } from '../errors.js';
import {
  favoritesDocumentSchema,
  playlistDocumentSchema,
  tidekeeperConfigSchema,
} from './schema.js';
import {
  pathExists,
  readYamlFile,
  validateValue,
  writeYamlFileAtomic,
} from './yaml.js';

export const configFileName = 'tidekeeper.yaml';
export const favoritesFileName = 'favorites.yaml';

export type LibraryPaths = {
  config: string;
  favorites: string;
  library: string;
  playlists: string;
  root: string;
  state: string;
};

export function createLibraryPaths(
  root: string,
  config: TidekeeperConfig = {
    libraryDirectory: 'library',
    schemaVersion: 1,
  },
): LibraryPaths {
  const absoluteRoot = resolve(root);
  const library = resolve(absoluteRoot, config.libraryDirectory);
  if (
    library !== absoluteRoot &&
    !library.startsWith(
      `${absoluteRoot}${process.platform === 'win32' ? '\\' : '/'}`,
    )
  ) {
    throw new ValidationError('Library directory escapes the Tidekeeper root.');
  }
  return {
    config: join(absoluteRoot, configFileName),
    favorites: join(library, favoritesFileName),
    library,
    playlists: join(library, 'playlists'),
    root: absoluteRoot,
    state: join(absoluteRoot, '.tidekeeper'),
  };
}

export async function initializeLibrary(
  root: string,
  countryCode?: string,
  force = false,
): Promise<LibraryPaths> {
  const config: TidekeeperConfig = {
    ...(countryCode === undefined ? {} : { countryCode }),
    libraryDirectory: 'library',
    schemaVersion: 1,
  };
  const parsedConfig = validateValue(config, tidekeeperConfigSchema);
  const paths = createLibraryPaths(root, parsedConfig);
  await assertLibraryPathContained(paths);
  if (!force && (await pathExists(paths.config))) {
    throw new ValidationError(
      `${paths.config} already exists. Use --force to replace it.`,
    );
  }

  const favorites: FavoritesDocument = {
    kind: 'favorites',
    schemaVersion: 1,
    tracks: [],
  };
  await writeYamlFileAtomic(paths.config, parsedConfig, tidekeeperConfigSchema);
  await writeYamlFileAtomic(
    paths.favorites,
    favorites,
    favoritesDocumentSchema,
  );
  return paths;
}

export async function loadLibrary(root: string): Promise<LibrarySnapshot> {
  const initialPaths = createLibraryPaths(root);
  const config = await readYamlFile(
    initialPaths.config,
    tidekeeperConfigSchema,
  );
  const paths = createLibraryPaths(root, config);
  await assertLibraryPathContained(paths);
  const favorites = await readYamlFile(
    paths.favorites,
    favoritesDocumentSchema,
  );
  const playlists = await readPlaylists(paths.playlists);
  validateUniquePlaylistIdentities(playlists);
  return { config, favorites, playlists };
}

export async function recoverLibraryReplacement(root: string): Promise<void> {
  const initialPaths = createLibraryPaths(root);
  const config = await readYamlFile(
    initialPaths.config,
    tidekeeperConfigSchema,
  );
  const paths = createLibraryPaths(root, config);
  await assertLibraryPathContained(paths);
  let entries;
  try {
    entries = await readdir(paths.state, { withFileTypes: true });
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return;
    }
    throw new ValidationError('Unable to inspect Tidekeeper recovery state.', {
      cause: error,
    });
  }

  const backupDirectories = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('backup-'))
    .map((entry) => join(paths.state, entry.name))
    .sort();
  const stagingDirectories = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('staging-'))
    .map((entry) => join(paths.state, entry.name))
    .sort();

  if (!(await pathExists(paths.library))) {
    if (backupDirectories.length > 1) {
      throw new ValidationError(
        'Multiple library backups require manual recovery in .tidekeeper.',
      );
    }
    const backup = backupDirectories[0];
    if (backup) {
      await mkdir(dirname(paths.library), { recursive: true });
      await rename(backup, paths.library);
    } else {
      const stagedLibraries = [];
      for (const stagingDirectory of stagingDirectories) {
        const stagedLibrary = join(stagingDirectory, 'library');
        if (await pathExists(stagedLibrary)) {
          stagedLibraries.push(stagedLibrary);
        }
      }
      if (stagedLibraries.length > 1) {
        throw new ValidationError(
          'Multiple staged libraries require manual recovery in .tidekeeper.',
        );
      }
      const stagedLibrary = stagedLibraries[0];
      if (stagedLibrary) {
        await mkdir(dirname(paths.library), { recursive: true });
        await rename(stagedLibrary, paths.library);
      }
    }
  }

  if (await pathExists(paths.library)) {
    await Promise.all(
      [...backupDirectories, ...stagingDirectories].map((directory) =>
        rm(directory, { force: true, recursive: true }),
      ),
    );
  }
}

export async function writeLibrarySnapshot(
  root: string,
  snapshot: LibrarySnapshot,
): Promise<void> {
  const paths = createLibraryPaths(root, snapshot.config);
  await assertLibraryPathContained(paths);
  const stagingRoot = join(paths.state, `staging-${randomUUID()}`);
  const stagedLibrary = join(stagingRoot, 'library');
  const stagedFavorites = join(stagedLibrary, favoritesFileName);
  const stagedPlaylists = join(stagedLibrary, 'playlists');
  const backupLibrary = join(paths.state, `backup-${randomUUID()}`);

  let movedExistingLibrary = false;
  try {
    await writeYamlFileAtomic(
      stagedFavorites,
      snapshot.favorites,
      favoritesDocumentSchema,
    );
    for (const playlist of snapshot.playlists) {
      await writeYamlFileAtomic(
        join(stagedPlaylists, playlistFileName(playlist)),
        playlist,
        playlistDocumentSchema,
      );
    }

    await mkdir(dirname(paths.library), { recursive: true });
    if (await pathExists(paths.library)) {
      await rename(paths.library, backupLibrary);
      movedExistingLibrary = true;
    }
    await rename(stagedLibrary, paths.library);
    await rm(backupLibrary, { force: true, recursive: true });
    await rm(stagingRoot, { force: true, recursive: true });
  } catch (error: unknown) {
    if (movedExistingLibrary && !(await pathExists(paths.library))) {
      await rename(backupLibrary, paths.library);
    }
    await rm(stagingRoot, { force: true, recursive: true }).catch(
      () => undefined,
    );
    throw new ValidationError('Unable to replace the local library snapshot.', {
      cause: error,
    });
  }
}

async function assertLibraryPathContained(paths: LibraryPaths): Promise<void> {
  const canonicalRoot = await realpath(paths.root);
  let existingPath = paths.library;
  while (!(await pathExists(existingPath))) {
    const parent = dirname(existingPath);
    if (parent === existingPath) {
      throw new ValidationError('Library directory cannot be resolved.');
    }
    existingPath = parent;
  }

  const canonicalExistingPath = await realpath(existingPath);
  if (
    canonicalExistingPath !== canonicalRoot &&
    !canonicalExistingPath.startsWith(
      `${canonicalRoot}${process.platform === 'win32' ? '\\' : '/'}`,
    )
  ) {
    throw new ValidationError(
      'Library directory resolves outside the Tidekeeper root.',
    );
  }
}

export function playlistFileName(playlist: PlaylistDocument): string {
  const identity = playlist.id ?? playlist.localId;
  if (!identity) {
    throw new ValidationError('Playlist has no stable identity.');
  }
  return `${slugify(playlist.title)}--${identity}.yaml`;
}

export function createLocalPlaylist(title: string): PlaylistDocument {
  return {
    description: '',
    id: null,
    kind: 'playlist',
    localId: randomUUID(),
    schemaVersion: 1,
    title,
    tracks: [],
  };
}

async function readPlaylists(directory: string): Promise<PlaylistDocument[]> {
  if (!(await pathExists(directory))) {
    return [];
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const fileNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  return Promise.all(
    fileNames.map(async (fileName) => {
      const playlist = await readYamlFile(
        join(directory, fileName),
        playlistDocumentSchema,
      );
      const expectedSuffix = `--${playlist.id ?? playlist.localId}.yaml`;
      if (!basename(fileName).endsWith(expectedSuffix)) {
        throw new ValidationError(
          `${fileName} does not match playlist identity ${playlist.id ?? playlist.localId}.`,
        );
      }
      return playlist;
    }),
  );
}

function validateUniquePlaylistIdentities(
  playlists: readonly PlaylistDocument[],
): void {
  const seen = new Set<string>();
  for (const playlist of playlists) {
    const identity = playlist.id ?? playlist.localId;
    if (!identity) {
      throw new ValidationError('Playlist has no stable identity.');
    }
    if (seen.has(identity)) {
      throw new ValidationError(`Duplicate playlist identity: ${identity}.`);
    }
    seen.add(identity);
  }
}

function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'playlist';
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
