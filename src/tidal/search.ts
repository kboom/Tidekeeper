import type { TrackReference } from '../domain.js';
import {
  executeTidalRequest,
  type TidalApiClient,
  throwForTidalError,
} from './client.js';
import { hydrateTrackIdentifiers } from './tracks.js';

export type SearchTracksOptions = {
  countryCode?: string;
  explicitFilter?: 'INCLUDE' | 'EXCLUDE';
  limit?: number;
};

export async function searchTracks(
  client: TidalApiClient,
  query: string,
  options: SearchTracksOptions = {},
): Promise<TrackReference[]> {
  const tracks: TrackReference[] = [];
  let cursor: string | undefined;

  do {
    const response = await executeTidalRequest('TIDAL track search', () =>
      client.GET('/searchResults/{id}/relationships/tracks', {
        params: {
          path: { id: query },
          query: {
            include: ['tracks'],
            ...(cursor ? { 'page[cursor]': cursor } : {}),
            ...(options.countryCode
              ? { countryCode: options.countryCode }
              : {}),
            ...(options.explicitFilter
              ? { explicitFilter: options.explicitFilter }
              : {}),
          },
        },
      }),
    );
    if (response.error) {
      throwForTidalError(response.error, 'TIDAL track search');
    }

    const remaining =
      options.limit === undefined
        ? undefined
        : Math.max(options.limit - tracks.length, 0);
    const identifiers =
      remaining === undefined
        ? (response.data.data ?? [])
        : (response.data.data ?? []).slice(0, remaining);
    tracks.push(
      ...(await hydrateTrackIdentifiers(
        client,
        identifiers,
        options.countryCode,
      )),
    );

    if (options.limit !== undefined && tracks.length >= options.limit) {
      return tracks;
    }
    cursor = response.data.links.meta?.nextCursor;
  } while (cursor);

  return tracks;
}
