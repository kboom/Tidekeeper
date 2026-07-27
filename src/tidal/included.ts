import type { components } from '@tidal-music/api';

import { NetworkError } from '../errors.js';

type Included = components['schemas']['Included'];
type IncludedResource = Included[number];
type TrackResource = components['schemas']['Tracks_Resource_Object'];
type AlbumResource = components['schemas']['Albums_Resource_Object'];
type ArtistResource = components['schemas']['Artists_Resource_Object'];

export type IncludedIndex = {
  getAlbum(id: string): AlbumResource | undefined;
  getArtist(id: string): ArtistResource | undefined;
  getTrack(id: string): TrackResource | undefined;
};

export function indexIncluded(included: Included | undefined): IncludedIndex {
  const resources = new Map<string, IncludedResource>();
  for (const resource of included ?? []) {
    resources.set(resourceKey(resource.type, resource.id), resource);
  }

  return {
    getAlbum: (id) => asAlbum(resources.get(resourceKey('albums', id))),
    getArtist: (id) => asArtist(resources.get(resourceKey('artists', id))),
    getTrack: (id) => asTrack(resources.get(resourceKey('tracks', id))),
  };
}

export function requireTrack(
  included: IncludedIndex,
  id: string,
): TrackResource {
  const track = included.getTrack(id);
  if (!track?.attributes) {
    throw new NetworkError(`TIDAL response omitted track metadata for ${id}.`);
  }
  return track;
}

function asAlbum(
  resource: IncludedResource | undefined,
): AlbumResource | undefined {
  return resource?.type === 'albums' ? resource : undefined;
}

function asArtist(
  resource: IncludedResource | undefined,
): ArtistResource | undefined {
  return resource?.type === 'artists' ? resource : undefined;
}

function asTrack(
  resource: IncludedResource | undefined,
): TrackResource | undefined {
  return resource?.type === 'tracks' ? resource : undefined;
}

function resourceKey(type: string, id: string): string {
  return `${type}:${id}`;
}
