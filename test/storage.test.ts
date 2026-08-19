import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { FavoritesDocument, PlaylistDocument } from '../src/domain.js';
import { ValidationError } from '../src/errors.js';
import {
  createLibraryPaths,
  createLocalPlaylist,
  initializeLibrary,
  loadLibrary,
  playlistFileName,
  recoverLibraryReplacement,
  writeLibrarySnapshot,
} from '../src/storage/library.js';
import {
  favoritesDocumentSchema,
  playlistDocumentSchema,
} from '../src/storage/schema.js';
import {
  ensureDirectory,
  readYamlFile,
  serializeYaml,
  writeYamlFileAtomic,
} from '../src/storage/yaml.js';

describe('library storage', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it('initializes and loads an empty library', async () => {
    const root = await createTemporaryRoot();

    const paths = await initializeLibrary(root, 'US');
    const library = await loadLibrary(root);

    expect(library).toEqual({
      config: {
        countryCode: 'US',
        libraryDirectory: 'library',
        schemaVersion: 1,
      },
      favorites: {
        kind: 'favorites',
        schemaVersion: 1,
        tracks: [],
      },
      playlists: [],
    });

    await expect(readFile(paths.config, 'utf8')).resolves.toContain(
      'countryCode: US',
    );
  });

  it('accepts an existing filesystem root as a writable parent directory', async () => {
    await expect(
      ensureDirectory(parse(resolve(process.cwd())).root),
    ).resolves.toBeUndefined();
  });

  it('serializes playlist YAML deterministically', () => {
    const playlist: PlaylistDocument = {
      description: 'Deep work',
      id: 'playlist-1',
      kind: 'playlist',
      schemaVersion: 1,
      title: 'Focus',
      tracks: [
        {
          album: 'Example Album',
          artists: ['Example Artist'],
          audio: {
            bitDepth: 24,
            format: 'FLAC_HIRES',
            mediaTags: ['HIRES_LOSSLESS'],
            sampleRateHz: 96_000,
          },
          id: 'track-1',
          title: 'Example Track',
        },
      ],
    };

    expect(serializeYaml(playlist, playlistDocumentSchema)).toBe(
      [
        'description: Deep work',
        'id: playlist-1',
        'kind: playlist',
        'schemaVersion: 1',
        'title: Focus',
        'tracks:',
        '  - album: Example Album',
        '    artists:',
        '      - Example Artist',
        '    audio:',
        '      bitDepth: 24',
        '      format: FLAC_HIRES',
        '      mediaTags:',
        '        - HIRES_LOSSLESS',
        '      sampleRateHz: 96000',
        '    id: track-1',
        '    title: Example Track',
        '',
      ].join('\n'),
    );
  });

  it('rejects unresolved Git conflict markers', async () => {
    const root = await createTemporaryRoot();
    const path = join(root, 'favorites.yaml');
    await writeFile(
      path,
      [
        '<<<<<<< HEAD',
        'schemaVersion: 1',
        '=======',
        'schemaVersion: 2',
        '>>>>>>> branch',
      ].join('\n'),
    );

    await expect(readYamlFile(path, favoritesDocumentSchema)).rejects.toThrow(
      /unresolved Git conflict markers/,
    );
  });

  it('rejects duplicate favorite track IDs', () => {
    const favorites: FavoritesDocument = {
      kind: 'favorites',
      schemaVersion: 1,
      tracks: [
        { artists: ['Artist'], id: 'duplicate', title: 'One' },
        { artists: ['Artist'], id: 'duplicate', title: 'Two' },
      ],
    };

    expect(() => serializeYaml(favorites, favoritesDocumentSchema)).toThrow(
      /Duplicate favorite track ID/,
    );
  });

  it('requires local playlists to have a stable local ID', () => {
    const playlist: PlaylistDocument = {
      description: '',
      id: null,
      kind: 'playlist',
      schemaVersion: 1,
      title: 'Draft',
      tracks: [],
    };

    expect(() => serializeYaml(playlist, playlistDocumentSchema)).toThrow(
      /localId/,
    );
  });

  it('loads playlist files and checks their identity suffix', async () => {
    const root = await createTemporaryRoot();
    const paths = await initializeLibrary(root);
    const playlist = createLocalPlaylist('Focus & Flow');
    const fileName = playlistFileName(playlist);
    await writeYamlFileAtomic(
      join(paths.playlists, fileName),
      playlist,
      playlistDocumentSchema,
    );

    const library = await loadLibrary(root);

    expect(fileName).toBe(`focus-flow--${playlist.localId}.yaml`);
    expect(library.playlists).toEqual([playlist]);
  });

  it('rejects a playlist filename with the wrong identity', async () => {
    const root = await createTemporaryRoot();
    const paths = await initializeLibrary(root);
    const playlist = createLocalPlaylist('Focus');
    await writeYamlFileAtomic(
      join(paths.playlists, 'focus--wrong-id.yaml'),
      playlist,
      playlistDocumentSchema,
    );

    await expect(loadLibrary(root)).rejects.toBeInstanceOf(ValidationError);
  });

  it('keeps the previous snapshot and removes staging data after validation fails', async () => {
    const root = await createTemporaryRoot();
    const paths = await initializeLibrary(root);
    await writeYamlFileAtomic(
      paths.favorites,
      {
        kind: 'favorites',
        schemaVersion: 1,
        tracks: [{ artists: ['Artist'], id: 'old', title: 'Old' }],
      },
      favoritesDocumentSchema,
    );
    const original = await loadLibrary(root);

    await expect(
      writeLibrarySnapshot(root, {
        ...original,
        favorites: {
          kind: 'favorites',
          schemaVersion: 1,
          tracks: [{ artists: ['Artist'], id: 'new', title: 'New' }],
        },
        playlists: [
          {
            description: '',
            id: 'invalid-playlist',
            kind: 'playlist',
            schemaVersion: 1,
            title: '',
            tracks: [],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(await loadLibrary(root)).toEqual(original);
    const stateEntries = await readdir(paths.state);
    expect(
      stateEntries.filter((entry) => entry.startsWith('staging-')),
    ).toEqual([]);
  });

  it('restores an interrupted library replacement from its backup', async () => {
    const root = await createTemporaryRoot();
    const paths = await initializeLibrary(root);
    await mkdir(paths.state, { recursive: true });
    await rename(paths.library, join(paths.state, 'backup-interrupted'));

    await recoverLibraryReplacement(root);

    await expect(loadLibrary(root)).resolves.toMatchObject({
      favorites: { tracks: [] },
    });
    expect(await readdir(paths.state)).not.toContain('backup-interrupted');
  });

  it('rejects an external library directory junction before writing files', async () => {
    const root = await createTemporaryRoot();
    const externalRoot = await createTemporaryRoot();
    await symlink(externalRoot, join(root, 'library'), 'junction');

    await expect(initializeLibrary(root)).rejects.toThrow(
      /resolves outside the Tidekeeper root/,
    );
    await expect(
      readFile(join(externalRoot, 'favorites.yaml'), 'utf8'),
    ).rejects.toThrow(/ENOENT/);
  });

  async function createTemporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'tidekeeper-storage-'));
    temporaryRoots.push(root);
    return root;
  }
});

describe('library path safety', () => {
  it('rejects a library directory outside the repository', () => {
    expect(() =>
      createLibraryPaths(process.cwd(), {
        libraryDirectory: '..',
        schemaVersion: 1,
      }),
    ).toThrow(/escapes/);
  });
});
