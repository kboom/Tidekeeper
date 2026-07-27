import type { PlaylistDocument, TrackReference } from '../domain.js';
import { NetworkError } from '../errors.js';
import { chunkItems } from './chunks.js';
import {
  executeTidalRequest,
  type TidalApiClient,
  throwForTidalError,
} from './client.js';
import { hydrateTrackIdentifiers } from './tracks.js';

export async function getOwnedPlaylists(
  client: TidalApiClient,
  countryCode?: string,
): Promise<PlaylistDocument[]> {
  const playlists: PlaylistDocument[] = [];
  let cursor: string | undefined;

  do {
    const response = await executeTidalRequest(
      'Loading owned TIDAL playlists',
      () =>
        client.GET('/playlists', {
          params: {
            query: {
              'filter[owners.id]': ['me'],
              sort: ['name'],
              ...(cursor ? { 'page[cursor]': cursor } : {}),
              ...(countryCode ? { countryCode } : {}),
            },
          },
        }),
    );
    if (response.error) {
      throwForTidalError(response.error, 'Loading owned TIDAL playlists');
    }

    const page: PlaylistDocument[] = [];
    for (const playlist of response.data.data) {
      if (!playlist.attributes) {
        throw new NetworkError(
          `TIDAL response omitted attributes for playlist ${playlist.id}.`,
        );
      }
      page.push({
        description: playlist.attributes.description ?? '',
        id: playlist.id,
        kind: 'playlist',
        schemaVersion: 1,
        title: playlist.attributes.name,
        tracks: await getPlaylistTracks(client, playlist.id, countryCode),
      });
    }
    playlists.push(...page);
    cursor = response.data.links.meta?.nextCursor;
  } while (cursor);

  return playlists.sort((left, right) =>
    (left.id ?? '').localeCompare(right.id ?? ''),
  );
}

export async function createPlaylist(
  client: TidalApiClient,
  playlist: { description: string; title: string },
  idempotencyKey: string,
  countryCode?: string,
): Promise<string> {
  const response = await executeTidalRequest('Creating TIDAL playlist', () =>
    client.POST('/playlists', {
      params: {
        header: { 'Idempotency-Key': idempotencyKey },
        query: { ...(countryCode ? { countryCode } : {}) },
      },
      body: {
        data: {
          attributes: {
            description: playlist.description,
            name: playlist.title,
          },
          type: 'playlists',
        },
      },
    }),
  );
  if (response.error) {
    throwForTidalError(response.error, 'Creating TIDAL playlist');
  }
  return response.data.data.id;
}

export async function updatePlaylist(
  client: TidalApiClient,
  playlistId: string,
  attributes: { description: string; title: string },
  idempotencyKey: string,
  countryCode?: string,
): Promise<void> {
  const response = await executeTidalRequest('Updating TIDAL playlist', () =>
    client.PATCH('/playlists/{id}', {
      params: {
        header: { 'Idempotency-Key': idempotencyKey },
        path: { id: playlistId },
        query: { ...(countryCode ? { countryCode } : {}) },
      },
      body: {
        data: {
          attributes: {
            description: attributes.description,
            name: attributes.title,
          },
          id: playlistId,
          type: 'playlists',
        },
      },
    }),
  );
  if (response.error) {
    throwForTidalError(response.error, 'Updating TIDAL playlist');
  }
}

export async function deletePlaylist(
  client: TidalApiClient,
  playlistId: string,
  idempotencyKey: string,
): Promise<void> {
  const response = await executeTidalRequest('Deleting TIDAL playlist', () =>
    client.DELETE('/playlists/{id}', {
      params: {
        header: { 'Idempotency-Key': idempotencyKey },
        path: { id: playlistId },
      },
    }),
  );
  if (response.error) {
    throwForTidalError(response.error, 'Deleting TIDAL playlist');
  }
}

export async function replacePlaylistTracks(
  client: TidalApiClient,
  playlistId: string,
  currentTracks: readonly TrackReference[],
  desiredTrackIds: readonly string[],
  idempotencyKey: string,
  countryCode?: string,
): Promise<void> {
  for (const [index, chunk] of chunkItems(currentTracks).entries()) {
    const response = await executeTidalRequest(
      'Removing TIDAL playlist tracks',
      () =>
        client.DELETE('/playlists/{id}/relationships/items', {
          params: {
            header: {
              'Idempotency-Key': `${idempotencyKey}-remove-${index}`,
            },
            path: { id: playlistId },
          },
          body: {
            data: chunk.map((track) => {
              if (!track.itemId) {
                throw new NetworkError(
                  `TIDAL response omitted itemId for playlist item ${track.id}.`,
                );
              }
              return {
                id: track.id,
                meta: { itemId: track.itemId },
                type: 'tracks' as const,
              };
            }),
          },
        }),
    );
    if (response.error) {
      throwForTidalError(response.error, 'Removing TIDAL playlist tracks');
    }
  }

  for (const [index, chunk] of chunkItems(desiredTrackIds).entries()) {
    const response = await executeTidalRequest(
      'Adding TIDAL playlist tracks',
      () =>
        client.POST('/playlists/{id}/relationships/items', {
          params: {
            header: {
              'Idempotency-Key': `${idempotencyKey}-add-${index}`,
            },
            path: { id: playlistId },
            query: { ...(countryCode ? { countryCode } : {}) },
          },
          body: {
            data: chunk.map((id) => ({
              id,
              type: 'tracks' as const,
            })),
          },
        }),
    );
    if (response.error) {
      throwForTidalError(response.error, 'Adding TIDAL playlist tracks');
    }
  }
}

async function getPlaylistTracks(
  client: TidalApiClient,
  playlistId: string,
  countryCode?: string,
): Promise<TrackReference[]> {
  const tracks: TrackReference[] = [];
  let cursor: string | undefined;

  do {
    const response = await executeTidalRequest(
      `Loading tracks for TIDAL playlist ${playlistId}`,
      () =>
        client.GET('/playlists/{id}/relationships/items', {
          params: {
            path: { id: playlistId },
            query: {
              include: ['items'],
              sort: ['itemIndex'],
              ...(cursor ? { 'page[cursor]': cursor } : {}),
              ...(countryCode ? { countryCode } : {}),
            },
          },
        }),
    );
    if (response.error) {
      throwForTidalError(
        response.error,
        `Loading tracks for TIDAL playlist ${playlistId}`,
      );
    }

    const identifiers = (response.data.data ?? []).filter(
      (identifier) => identifier.type === 'tracks',
    );
    const hydrated = await hydrateTrackIdentifiers(
      client,
      identifiers,
      countryCode,
    );
    tracks.push(
      ...hydrated.map((track, index) => ({
        ...track,
        ...(identifiers[index]?.meta?.addedAt
          ? { addedAt: identifiers[index].meta.addedAt }
          : {}),
        ...(identifiers[index]?.meta?.itemId
          ? { itemId: identifiers[index].meta.itemId }
          : {}),
      })),
    );
    cursor = response.data.links.meta?.nextCursor;
  } while (cursor);

  return tracks;
}
