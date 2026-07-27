import type { components } from '@tidal-music/api';

import type { TrackReference } from '../domain.js';
import {
  executeTidalRequest,
  type TidalApiClient,
  throwForTidalError,
} from './client.js';
import { indexIncluded } from './included.js';
import { normalizeTrack } from './normalize.js';

type ResourceIdentifier = components['schemas']['Resource_Identifier'];

export async function hydrateTrackIdentifiers(
  client: TidalApiClient,
  identifiers: readonly ResourceIdentifier[],
  countryCode?: string,
): Promise<TrackReference[]> {
  if (identifiers.length === 0) {
    return [];
  }

  const ids = [...new Set(identifiers.map((identifier) => identifier.id))];
  const response = await executeTidalRequest(
    'Loading TIDAL track metadata',
    () =>
      client.GET('/tracks', {
        params: {
          query: {
            'filter[id]': ids,
            include: ['albums', 'artists'],
            ...(countryCode ? { countryCode } : {}),
          },
        },
      }),
  );
  if (response.error) {
    throwForTidalError(response.error, 'Loading TIDAL track metadata');
  }

  const included = indexIncluded(response.data.included);
  const tracksById = new Map(
    response.data.data.map((track) => [
      track.id,
      normalizeTrack(track, included),
    ]),
  );

  return identifiers.map((identifier) => {
    const track = tracksById.get(identifier.id);
    return track ?? unavailableTrack(identifier.id);
  });
}

function unavailableTrack(id: string): TrackReference {
  return {
    artists: ['TIDAL metadata unavailable'],
    id,
    title: '[Unavailable track]',
    unavailable: true,
  };
}
