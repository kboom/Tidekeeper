import type { components } from '@tidal-music/api';

import type { TrackReference } from '../domain.js';
import { NetworkError } from '../errors.js';
import { type IncludedIndex, indexIncluded } from './included.js';

type TrackResource = components['schemas']['Tracks_Resource_Object'];

export function normalizeTrack(
  resource: TrackResource,
  includedResources:
    components['schemas']['Included'] | IncludedIndex | undefined,
): TrackReference {
  if (!resource.attributes) {
    throw new NetworkError(
      `TIDAL response omitted attributes for track ${resource.id}.`,
    );
  }

  const included =
    includedResources && 'getTrack' in includedResources
      ? includedResources
      : indexIncluded(includedResources);
  const artistIds = resource.relationships?.artists?.data?.map(
    (artist) => artist.id,
  );
  const albumId = resource.relationships?.albums?.data?.at(0)?.id;
  const externalUrl = resource.attributes.externalLinks?.find(
    (link) => link.meta.type === 'TIDAL_SHARING',
  )?.href;
  const mediaTags = readMediaTags(resource.attributes);

  return {
    id: resource.id,
    title: resource.attributes.title,
    artists:
      artistIds?.map((id) => included.getArtist(id)?.attributes?.name ?? id) ??
      [],
    ...(albumId
      ? { album: included.getAlbum(albumId)?.attributes?.title ?? albumId }
      : {}),
    ...(mediaTags.length ? { audio: { mediaTags } } : {}),
    durationSeconds: parseIsoDuration(resource.attributes.duration),
    explicit: resource.attributes.explicit,
    tidalUrl: externalUrl ?? `https://tidal.com/browse/track/${resource.id}`,
  };
}

function readMediaTags(attributes: {
  mediaTags?: readonly string[];
}): string[] {
  return [...(attributes.mediaTags ?? [])];
}

export function parseIsoDuration(duration: string): number {
  const match =
    /^P(?:(?<days>\d+)D)?(?:T(?:(?<hours>\d+)H)?(?:(?<minutes>\d+)M)?(?:(?<seconds>\d+(?:\.\d+)?)S)?)?$/u.exec(
      duration,
    );
  if (!match?.groups) {
    throw new NetworkError(
      `TIDAL returned an invalid ISO 8601 duration: ${duration}`,
    );
  }

  const days = Number(match.groups.days ?? 0);
  const hours = Number(match.groups.hours ?? 0);
  const minutes = Number(match.groups.minutes ?? 0);
  const seconds = Number(match.groups.seconds ?? 0);
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}
