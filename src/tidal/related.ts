import type { TrackReference } from '../domain.js';
import {
  executeTidalRequest,
  type TidalApiClient,
  throwForTidalError,
} from './client.js';
import { hydrateTrackIdentifiers } from './tracks.js';

const trackFilterLimit = 20;

export type RelatedTracksOptions = {
  by: 'album' | 'artist';
  limitPerSource: number;
};

export async function findRelatedTracks(
  client: TidalApiClient,
  seeds: readonly TrackReference[],
  options: RelatedTracksOptions,
): Promise<TrackReference[]> {
  const sourceIds = await loadSourceIds(client, seeds, options.by);
  const relatedIds: string[] = [];
  for (const sourceId of sourceIds) {
    relatedIds.push(
      ...(await loadRelatedIds(
        client,
        sourceId,
        options.by,
        options.limitPerSource,
      )),
    );
  }

  const seedIds = new Set(seeds.map((track) => track.id));
  const uniqueIds = [
    ...new Set(relatedIds.filter((trackId) => !seedIds.has(trackId))),
  ];
  const tracks: TrackReference[] = [];
  for (let index = 0; index < uniqueIds.length; index += trackFilterLimit) {
    const ids = uniqueIds.slice(index, index + trackFilterLimit);
    tracks.push(
      ...(await hydrateTrackIdentifiers(
        client,
        ids.map((id) => ({ id, type: 'tracks' })),
      )),
    );
  }
  return tracks.filter((track) => !track.unavailable);
}

async function loadSourceIds(
  client: TidalApiClient,
  seeds: readonly TrackReference[],
  by: RelatedTracksOptions['by'],
): Promise<string[]> {
  const sourceIds: string[] = [];
  for (let index = 0; index < seeds.length; index += trackFilterLimit) {
    const ids = seeds
      .slice(index, index + trackFilterLimit)
      .map((track) => track.id);
    const response = await executeTidalRequest(
      `Loading TIDAL ${by} relationships`,
      () =>
        client.GET('/tracks', {
          params: {
            query: {
              'filter[id]': ids,
              include: by === 'album' ? ['albums'] : ['artists'],
            },
          },
        }),
    );
    if (response.error) {
      throwForTidalError(response.error, `Loading TIDAL ${by} relationships`);
    }
    for (const track of response.data.data) {
      const identifiers =
        by === 'album'
          ? (track.relationships?.albums?.data ?? [])
          : (track.relationships?.artists?.data ?? []);
      sourceIds.push(...identifiers.map((identifier) => identifier.id));
    }
  }
  return [...new Set(sourceIds)];
}

async function loadRelatedIds(
  client: TidalApiClient,
  sourceId: string,
  by: RelatedTracksOptions['by'],
  limit: number,
): Promise<string[]> {
  return by === 'album'
    ? loadAlbumTrackIds(client, sourceId, limit)
    : loadArtistTrackIds(client, sourceId, limit);
}

async function loadAlbumTrackIds(
  client: TidalApiClient,
  albumId: string,
  limit: number,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const response = await executeTidalRequest(
      `Loading tracks for TIDAL album ${albumId}`,
      () =>
        client.GET('/albums/{id}/relationships/items', {
          params: {
            path: { id: albumId },
            query: {
              include: ['items'],
              ...(cursor ? { 'page[cursor]': cursor } : {}),
            },
          },
        }),
    );
    if (response.error) {
      throwForTidalError(
        response.error,
        `Loading tracks for TIDAL album ${albumId}`,
      );
    }
    ids.push(
      ...(response.data.data ?? [])
        .filter((identifier) => identifier.type === 'tracks')
        .map((identifier) => identifier.id)
        .slice(0, limit - ids.length),
    );
    cursor = response.data.links.meta?.nextCursor;
  } while (cursor && ids.length < limit);
  return ids;
}

async function loadArtistTrackIds(
  client: TidalApiClient,
  artistId: string,
  limit: number,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const response = await executeTidalRequest(
      `Loading tracks for TIDAL artist ${artistId}`,
      () =>
        client.GET('/artists/{id}/relationships/tracks', {
          params: {
            path: { id: artistId },
            query: {
              collapseBy: 'FINGERPRINT',
              include: ['tracks'],
              ...(cursor ? { 'page[cursor]': cursor } : {}),
            },
          },
        }),
    );
    if (response.error) {
      throwForTidalError(
        response.error,
        `Loading tracks for TIDAL artist ${artistId}`,
      );
    }
    ids.push(
      ...(response.data.data ?? [])
        .map((identifier) => identifier.id)
        .slice(0, limit - ids.length),
    );
    cursor = response.data.links.meta?.nextCursor;
  } while (cursor && ids.length < limit);
  return ids;
}
