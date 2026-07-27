import type { FavoritesDocument } from '../domain.js';
import { ConflictError } from '../errors.js';
import { chunkItems } from './chunks.js';
import {
  executeTidalRequest,
  type TidalApiClient,
  throwForTidalError,
} from './client.js';
import { hydrateTrackIdentifiers } from './tracks.js';

export async function getFavoriteTracks(
  client: TidalApiClient,
  countryCode?: string,
): Promise<FavoritesDocument> {
  const tracks: FavoritesDocument['tracks'] = [];
  let cursor: string | undefined;

  do {
    const response = await executeTidalRequest(
      'Loading TIDAL favorite tracks',
      () =>
        client.GET('/userCollectionTracks/{id}/relationships/items', {
          params: {
            path: { id: 'me' },
            query: {
              include: ['items'],
              ...(cursor ? { 'page[cursor]': cursor } : {}),
            },
          },
        }),
    );
    if (response.error) {
      throwForTidalError(response.error, 'Loading TIDAL favorite tracks');
    }

    const identifiers = response.data.data ?? [];
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
      })),
    );

    cursor = response.data.links.meta?.nextCursor;
  } while (cursor);

  return { kind: 'favorites', schemaVersion: 1, tracks };
}

export async function addFavoriteTracks(
  client: TidalApiClient,
  trackIds: string[],
  idempotencyKey: string,
): Promise<void> {
  if (trackIds.length === 0) {
    return;
  }

  for (const [index, chunk] of chunkItems(trackIds).entries()) {
    const response = await executeTidalRequest(
      'Adding TIDAL favorite tracks',
      () =>
        client.POST('/userCollectionTracks/{id}/relationships/items', {
          params: {
            header: { 'Idempotency-Key': `${idempotencyKey}-${index}` },
            path: { id: 'me' },
          },
          body: {
            data: chunk.map((id) => ({ id, type: 'tracks' as const })),
          },
        }),
    );
    if (response.error) {
      throwForTidalError(response.error, 'Adding TIDAL favorite tracks');
    }
    const missing = response.data.meta?.skipped.filter(
      (item) => item.reason === 'NOT_FOUND',
    );
    if (missing && missing.length > 0) {
      throw new ConflictError(
        `TIDAL could not add favorite track IDs: ${missing.map((item) => item.id).join(', ')}.`,
      );
    }
  }
}

export async function removeFavoriteTracks(
  client: TidalApiClient,
  trackIds: string[],
  idempotencyKey: string,
): Promise<void> {
  if (trackIds.length === 0) {
    return;
  }

  for (const [index, chunk] of chunkItems(trackIds).entries()) {
    const response = await executeTidalRequest(
      'Removing TIDAL favorite tracks',
      () =>
        client.DELETE('/userCollectionTracks/{id}/relationships/items', {
          params: {
            header: { 'Idempotency-Key': `${idempotencyKey}-${index}` },
            path: { id: 'me' },
          },
          body: {
            data: chunk.map((id) => ({ id, type: 'tracks' as const })),
          },
        }),
    );
    if (response.error) {
      throwForTidalError(response.error, 'Removing TIDAL favorite tracks');
    }
  }
}
