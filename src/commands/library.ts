import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type {
  LibrarySnapshot,
  PlaylistDocument,
  TrackReference,
} from '../domain.js';
import { ConflictError, ValidationError } from '../errors.js';
import type { OutputFormatValue, OutputStreams } from '../output.js';
import { writeOutput } from '../output.js';
import {
  createLocalPlaylist,
  loadLibrary,
  writeLibrarySnapshot,
} from '../storage/library.js';
import { trackReferenceSchema } from '../storage/schema.js';
import { validateValue } from '../storage/yaml.js';
import { withSyncLock } from '../sync/lock.js';

export type LocalEditResult = {
  changedPaths: string[];
  fingerprint: string;
  status: 'updated';
};

export async function runLibrarySummary(
  root: string,
  output: OutputFormatValue,
  streams: OutputStreams,
): Promise<void> {
  const library = await loadLibrary(root);
  const result = {
    favoriteTracks: library.favorites.tracks.length,
    playlists: library.playlists.map((playlist) => ({
      id: playlist.id ?? playlist.localId ?? '',
      title: playlist.title,
      tracks: playlist.tracks.length,
      unavailableTracks: playlist.tracks.filter((track) => track.unavailable)
        .length,
    })),
    totalPlaylists: library.playlists.length,
    tracksInPlaylists: library.playlists.reduce(
      (count, playlist) => count + playlist.tracks.length,
      0,
    ),
  };
  writeOutput(streams.stdout, output, result, result.playlists);
}

export async function runPlaylistCreate(
  root: string,
  title: string,
  description: string,
  output: OutputFormatValue,
  streams: OutputStreams,
): Promise<void> {
  const playlist = createLocalPlaylist(title);
  playlist.description = description;
  const result = await editLibrary(root, (library) => ({
    changedPaths: ['library/playlists'],
    library: { ...library, playlists: [...library.playlists, playlist] },
  }));
  writeEditResult(result, output, streams);
}

export async function runPlaylistUpdate(
  root: string,
  identity: string,
  update: { description?: string; title?: string },
  output: OutputFormatValue,
  streams: OutputStreams,
): Promise<void> {
  if (update.title === undefined && update.description === undefined) {
    throw new ValidationError(
      'Specify --title or --description to update a playlist.',
    );
  }
  const result = await editLibrary(root, (library) => {
    const playlist = requirePlaylist(library, identity);
    const updated: PlaylistDocument = {
      ...playlist,
      ...(update.description === undefined
        ? {}
        : { description: update.description }),
      ...(update.title === undefined ? {} : { title: update.title }),
    };
    return {
      changedPaths: ['library/playlists'],
      library: replacePlaylist(library, playlist, updated),
    };
  });
  writeEditResult(result, output, streams);
}

export async function runPlaylistSetTracks(
  root: string,
  identity: string,
  tracksPath: string,
  output: OutputFormatValue,
  streams: OutputStreams,
): Promise<void> {
  const tracks = await readTracksFile(tracksPath);
  const result = await editLibrary(root, (library) => {
    const playlist = requirePlaylist(library, identity);
    if (
      playlist.tracks.some((track) => track.unavailable) &&
      JSON.stringify(playlist.tracks) !== JSON.stringify(tracks)
    ) {
      throw new ConflictError(
        `Playlist ${identity} contains unavailable tracks and cannot be rewritten safely.`,
      );
    }
    return {
      changedPaths: ['library/playlists'],
      library: replacePlaylist(library, playlist, { ...playlist, tracks }),
    };
  });
  writeEditResult(result, output, streams);
}

export async function runPlaylistDelete(
  root: string,
  identity: string,
  output: OutputFormatValue,
  streams: OutputStreams,
): Promise<void> {
  const result = await editLibrary(root, (library) => {
    const playlist = requirePlaylist(library, identity);
    return {
      changedPaths: ['library/playlists'],
      library: {
        ...library,
        playlists: library.playlists.filter((item) => item !== playlist),
      },
    };
  });
  writeEditResult(result, output, streams);
}

export async function runFavoritesAdd(
  root: string,
  tracksPath: string,
  output: OutputFormatValue,
  streams: OutputStreams,
): Promise<void> {
  const additions = await readTracksFile(tracksPath);
  const result = await editLibrary(root, (library) => {
    const known = new Set(library.favorites.tracks.map((track) => track.id));
    const duplicate = additions.find((track) => known.has(track.id));
    if (duplicate) {
      throw new ValidationError(`Track ${duplicate.id} is already a favorite.`);
    }
    const additionIds = new Set<string>();
    for (const track of additions) {
      if (additionIds.has(track.id)) {
        throw new ValidationError(`Track ${track.id} appears more than once.`);
      }
      additionIds.add(track.id);
    }
    return {
      changedPaths: ['library/favorites.yaml'],
      library: {
        ...library,
        favorites: {
          ...library.favorites,
          tracks: [...library.favorites.tracks, ...additions],
        },
      },
    };
  });
  writeEditResult(result, output, streams);
}

export async function runFavoritesRemove(
  root: string,
  trackIds: readonly string[],
  output: OutputFormatValue,
  streams: OutputStreams,
): Promise<void> {
  if (trackIds.length === 0 || trackIds.some((id) => id.trim() === '')) {
    throw new ValidationError('Provide at least one non-empty track ID.');
  }
  const result = await editLibrary(root, (library) => {
    const removals = new Set(trackIds);
    const existing = new Set(library.favorites.tracks.map((track) => track.id));
    const missing = [...removals].find((id) => !existing.has(id));
    if (missing) {
      throw new ValidationError(`Track ${missing} is not a favorite.`);
    }
    return {
      changedPaths: ['library/favorites.yaml'],
      library: {
        ...library,
        favorites: {
          ...library.favorites,
          tracks: library.favorites.tracks.filter(
            (track) => !removals.has(track.id),
          ),
        },
      },
    };
  });
  writeEditResult(result, output, streams);
}

async function editLibrary(
  root: string,
  transform: (library: LibrarySnapshot) => {
    changedPaths: string[];
    library: LibrarySnapshot;
  },
): Promise<LocalEditResult> {
  return withSyncLock(root, async () => {
    const library = await loadLibrary(root);
    const changed = transform(library);
    await writeLibrarySnapshot(root, changed.library);
    return {
      changedPaths: changed.changedPaths,
      fingerprint: await snapshotFingerprint(changed.library),
      status: 'updated',
    };
  });
}

function requirePlaylist(
  library: LibrarySnapshot,
  identity: string,
): PlaylistDocument {
  const matches = library.playlists.filter(
    (playlist) => playlist.id === identity || playlist.localId === identity,
  );
  if (matches.length !== 1) {
    throw new ValidationError(`Playlist not found: ${identity}.`);
  }
  const [playlist] = matches;
  if (!playlist) {
    throw new ValidationError(`Playlist not found: ${identity}.`);
  }
  return playlist;
}

function replacePlaylist(
  library: LibrarySnapshot,
  previous: PlaylistDocument,
  updated: PlaylistDocument,
): LibrarySnapshot {
  return {
    ...library,
    playlists: library.playlists.map((playlist) =>
      playlist === previous ? updated : playlist,
    ),
  };
}

async function readTracksFile(path: string): Promise<TrackReference[]> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(resolve(path), 'utf8'));
  } catch (error: unknown) {
    throw new ValidationError(`Unable to read JSON tracks file ${path}.`, {
      cause: error,
    });
  }
  if (!Array.isArray(value)) {
    throw new ValidationError(`Tracks file ${path} must contain a JSON array.`);
  }
  return value.map((track) => validateValue(track, trackReferenceSchema));
}

async function snapshotFingerprint(snapshot: LibrarySnapshot): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256')
    .update(JSON.stringify(snapshot), 'utf8')
    .digest('hex');
}

function writeEditResult(
  result: LocalEditResult,
  output: OutputFormatValue,
  streams: OutputStreams,
): void {
  writeOutput(streams.stdout, output, result, [
    {
      changedPaths: result.changedPaths.join(', '),
      fingerprint: result.fingerprint,
      status: result.status,
    },
  ]);
}
