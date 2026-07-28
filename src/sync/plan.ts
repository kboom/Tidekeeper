import { createHash } from 'node:crypto';

import type {
  LibrarySnapshot,
  PlaylistDocument,
  TrackReference,
} from '../domain.js';
import { ConflictError } from '../errors.js';

export type SyncOperation =
  | {
      kind: 'favorites.add';
      trackIds: string[];
    }
  | {
      kind: 'favorites.remove';
      trackIds: string[];
    }
  | {
      description: string;
      kind: 'playlist.create';
      localId: string;
      title: string;
      trackIds: string[];
    }
  | {
      currentDescription: string;
      currentTracks: TrackReference[];
      kind: 'playlist.delete';
      playlistId: string;
      title: string;
    }
  | {
      currentTracks: TrackReference[];
      kind: 'playlist.replaceTracks';
      playlistId: string;
      title: string;
      trackIds: string[];
    }
  | {
      currentDescription: string;
      currentTitle: string;
      description: string;
      kind: 'playlist.update';
      playlistId: string;
      title: string;
    };

export type SyncPlan = {
  digest: string;
  hasRemovals: boolean;
  localFingerprint: string;
  operations: SyncOperation[];
  remoteFingerprint: string;
};

export function buildSyncPlan(
  local: LibrarySnapshot,
  remote: LibrarySnapshot,
): SyncPlan {
  const operations: SyncOperation[] = [];
  planFavorites(local, remote, operations);
  planPlaylists(local, remote, operations);

  const localFingerprint = fingerprintSnapshot(local);
  const remoteFingerprint = fingerprintSnapshot(remote);
  const planData = {
    localFingerprint,
    operations,
    remoteFingerprint,
    version: 1,
  };

  return {
    digest: hash(planData),
    hasRemovals: operations.some(operationRemovesData),
    localFingerprint,
    operations,
    remoteFingerprint,
  };
}

export function fingerprintSnapshot(snapshot: LibrarySnapshot): string {
  return hash({
    favorites: snapshot.favorites.tracks.map((track) => track.id).sort(),
    playlists: snapshot.playlists
      .map((playlist) => ({
        description: playlist.description,
        id: playlist.id,
        localId: playlist.localId,
        title: playlist.title,
        tracks: remotelyRepresentedTracks(playlist.tracks).map((track) => ({
          id: track.id,
          itemId: track.itemId,
        })),
      }))
      .sort((left, right) =>
        (left.id ?? left.localId ?? '').localeCompare(
          right.id ?? right.localId ?? '',
        ),
      ),
  });
}

export function fingerprintSnapshotContent(snapshot: LibrarySnapshot): string {
  return hash(snapshot);
}

function planFavorites(
  local: LibrarySnapshot,
  remote: LibrarySnapshot,
  operations: SyncOperation[],
): void {
  const localIds = new Set(local.favorites.tracks.map((track) => track.id));
  const remoteIds = new Set(remote.favorites.tracks.map((track) => track.id));
  const removals = [...remoteIds].filter((id) => !localIds.has(id)).sort();
  const additions = [...localIds].filter((id) => !remoteIds.has(id)).sort();

  if (removals.length > 0) {
    operations.push({ kind: 'favorites.remove', trackIds: removals });
  }
  if (additions.length > 0) {
    operations.push({ kind: 'favorites.add', trackIds: additions });
  }
}

function planPlaylists(
  local: LibrarySnapshot,
  remote: LibrarySnapshot,
  operations: SyncOperation[],
): void {
  const localById = new Map(
    local.playlists
      .filter(
        (playlist): playlist is PlaylistDocument & { id: string } =>
          playlist.id !== null,
      )
      .map((playlist) => [playlist.id, playlist]),
  );
  const remoteById = new Map(
    remote.playlists
      .filter(
        (playlist): playlist is PlaylistDocument & { id: string } =>
          playlist.id !== null,
      )
      .map((playlist) => [playlist.id, playlist]),
  );

  for (const remotePlaylist of [...remoteById.values()].sort(
    comparePlaylists,
  )) {
    const localPlaylist = localById.get(remotePlaylist.id);
    if (!localPlaylist) {
      operations.push({
        currentDescription: remotePlaylist.description,
        currentTracks: remotePlaylist.tracks,
        kind: 'playlist.delete',
        playlistId: remotePlaylist.id,
        title: remotePlaylist.title,
      });
      continue;
    }

    if (
      localPlaylist.title !== remotePlaylist.title ||
      localPlaylist.description !== remotePlaylist.description
    ) {
      operations.push({
        currentDescription: remotePlaylist.description,
        currentTitle: remotePlaylist.title,
        description: localPlaylist.description,
        kind: 'playlist.update',
        playlistId: localPlaylist.id,
        title: localPlaylist.title,
      });
    }

    if (
      !sameTrackOrder(
        remotelyRepresentedTracks(localPlaylist.tracks),
        remotePlaylist.tracks,
      )
    ) {
      const unavailableTrackIds = remotePlaylist.tracks
        .filter((track) => track.unavailable)
        .map((track) => track.id);
      if (unavailableTrackIds.length > 0) {
        throw new ConflictError(
          `Playlist ${remotePlaylist.id} contains unavailable TIDAL track metadata (${unavailableTrackIds.join(', ')}). Pull preserves these tracks, but Tidekeeper will not rewrite their track list because TIDAL could remove them.`,
        );
      }
      operations.push({
        currentTracks: remotePlaylist.tracks,
        kind: 'playlist.replaceTracks',
        playlistId: localPlaylist.id,
        title: localPlaylist.title,
        trackIds: remotelyRepresentedTracks(localPlaylist.tracks).map(
          (track) => track.id,
        ),
      });
    }
  }

  for (const localPlaylist of local.playlists
    .filter((playlist) => playlist.id === null)
    .sort(comparePlaylists)) {
    if (!localPlaylist.localId) {
      continue;
    }
    operations.push({
      description: localPlaylist.description,
      kind: 'playlist.create',
      localId: localPlaylist.localId,
      title: localPlaylist.title,
      trackIds: remotelyRepresentedTracks(localPlaylist.tracks).map(
        (track) => track.id,
      ),
    });
  }

  for (const localPlaylist of localById.values()) {
    if (!remoteById.has(localPlaylist.id)) {
      throw new ConflictError(
        `Local playlist ${localPlaylist.id} no longer exists on TIDAL. Pull before pushing.`,
      );
    }
  }
}

function operationRemovesData(operation: SyncOperation): boolean {
  return (
    operation.kind === 'favorites.remove' ||
    operation.kind === 'playlist.delete' ||
    (operation.kind === 'playlist.replaceTracks' &&
      operation.currentTracks.length > 0)
  );
}

function sameTrackOrder(
  left: readonly TrackReference[],
  right: readonly TrackReference[],
): boolean {
  return (
    left.length === right.length &&
    left.every((track, index) => track.id === right[index]?.id)
  );
}

function remotelyRepresentedTracks(
  tracks: readonly TrackReference[],
): TrackReference[] {
  return tracks.filter((track) => !track.unavailable || track.itemId);
}

function comparePlaylists(
  left: PlaylistDocument,
  right: PlaylistDocument,
): number {
  return (left.id ?? left.localId ?? '').localeCompare(
    right.id ?? right.localId ?? '',
  );
}

function hash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}
