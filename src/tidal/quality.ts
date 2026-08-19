import { randomUUID } from 'node:crypto';

import type { TrackAudio, TrackReference } from '../domain.js';
import { AuthenticationError, NetworkError } from '../errors.js';
import { executeTidalRequest, type TidalApiClient } from './client.js';
import { hydrateTrackIdentifiers } from './tracks.js';

const hydrationBatchSize = 20;

export type InspectTracksOptions = {
  mediaTag: string;
  minBitDepth: number;
  minSampleRateHz: number;
};

export type TrackInspectionRejection = {
  bitDepth?: number;
  detail?: string;
  id: string;
  reason: 'inspection-failed' | 'media-tag' | 'quality' | 'unavailable';
  sampleRateHz?: number;
};

export type TrackInspectionResult = {
  candidates: number;
  inspected: number;
  mediaTag: string;
  rejected: TrackInspectionRejection[];
  tracks: TrackReference[];
};

export type ExactAudioLoader = (
  trackId: string,
) => Promise<{ bitDepth: number; format: string; sampleRateHz: number }>;

export async function inspectTrackQuality(
  client: TidalApiClient,
  tracks: readonly TrackReference[],
  options: InspectTracksOptions,
  loadExactAudio: ExactAudioLoader,
): Promise<TrackInspectionResult> {
  const uniqueTracks = [
    ...new Map(tracks.map((track) => [track.id, track])).values(),
  ];
  const hydrated: TrackReference[] = [];
  for (
    let index = 0;
    index < uniqueTracks.length;
    index += hydrationBatchSize
  ) {
    const batch = uniqueTracks.slice(index, index + hydrationBatchSize);
    hydrated.push(
      ...(await hydrateTrackIdentifiers(
        client,
        batch.map((track) => ({ id: track.id, type: 'tracks' })),
      )),
    );
  }

  const rejected: TrackInspectionRejection[] = [];
  const qualified: TrackReference[] = [];
  let inspected = 0;

  for (const track of hydrated) {
    if (track.unavailable) {
      rejected.push({ id: track.id, reason: 'unavailable' });
      continue;
    }
    if (!track.audio?.mediaTags?.includes(options.mediaTag)) {
      rejected.push({ id: track.id, reason: 'media-tag' });
      continue;
    }

    inspected += 1;
    try {
      const exactAudio = await loadExactAudio(track.id);
      const audio: TrackAudio = {
        ...track.audio,
        ...exactAudio,
      };
      if (
        exactAudio.bitDepth < options.minBitDepth ||
        exactAudio.sampleRateHz < options.minSampleRateHz
      ) {
        rejected.push({
          bitDepth: exactAudio.bitDepth,
          id: track.id,
          reason: 'quality',
          sampleRateHz: exactAudio.sampleRateHz,
        });
        continue;
      }
      qualified.push({ ...track, audio });
    } catch (error: unknown) {
      if (error instanceof AuthenticationError) {
        throw error;
      }
      rejected.push({
        detail: error instanceof Error ? error.message : 'Unknown error',
        id: track.id,
        reason: 'inspection-failed',
      });
    }
  }

  return {
    candidates: uniqueTracks.length,
    inspected,
    mediaTag: options.mediaTag,
    rejected,
    tracks: qualified,
  };
}

type DashAudioRepresentation = {
  bitDepth: number;
  codec: string;
  sampleRateHz: number;
};

const playbackFormats = ['HEAACV1', 'AACLC', 'FLAC', 'FLAC_HIRES'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readAttribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}=(["'])(.*?)\\1`, 'i').exec(tag)?.[2];
}

function decodeDashDataUri(uri: string): string {
  const match = /^data:[^;,]+;base64,(.+)$/is.exec(uri);
  if (!match) {
    throw new NetworkError(
      'TIDAL track manifest did not contain a base64 DASH data URI.',
    );
  }
  const encodedManifest = match[1];
  if (encodedManifest === undefined) {
    throw new NetworkError('TIDAL track manifest data URI was empty.');
  }
  return Buffer.from(encodedManifest, 'base64').toString('utf8');
}

export function parseDashAudioRepresentations(
  xml: string,
): DashAudioRepresentation[] {
  const representations: DashAudioRepresentation[] = [];
  for (const match of xml.matchAll(/<Representation\b[^>]*>/gi)) {
    const tag = match[0];
    const id = readAttribute(tag, 'id');
    const codec = readAttribute(tag, 'codecs');
    const sampleRate = readAttribute(tag, 'audioSamplingRate');
    const numericIdSegments = id?.match(/\d+/g);
    const bitDepth = Number.parseInt(numericIdSegments?.at(-1) ?? '', 10);
    const sampleRateHz = Number.parseInt(sampleRate ?? '', 10);
    if (
      codec === undefined ||
      !Number.isInteger(bitDepth) ||
      !Number.isInteger(sampleRateHz)
    ) {
      continue;
    }
    representations.push({ bitDepth, codec, sampleRateHz });
  }
  return representations;
}

function readManifestAttributes(payload: unknown): {
  formats: string[];
  uri: string;
} {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new NetworkError(
      'TIDAL track manifest response did not contain a resource.',
    );
  }
  const attributes = payload.data.attributes;
  if (!isRecord(attributes)) {
    throw new NetworkError(
      'TIDAL track manifest response did not contain attributes.',
    );
  }
  const { formats, uri } = attributes;
  if (
    !Array.isArray(formats) ||
    !formats.every((format) => typeof format === 'string') ||
    typeof uri !== 'string'
  ) {
    throw new NetworkError(
      'TIDAL track manifest response had invalid formats or URI.',
    );
  }
  return { formats, uri };
}

export async function loadPlaybackAudioQuality(
  accessToken: string,
  clientId: string,
  trackId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  bitDepth: number;
  format: string;
  sampleRateHz: number;
}> {
  const url = new URL(
    `trackManifests/${encodeURIComponent(trackId)}`,
    'https://openapi.tidal.com/v2/',
  );
  url.searchParams.set('adaptive', 'true');
  url.searchParams.set('manifestType', 'MPEG_DASH');
  url.searchParams.set('uriScheme', 'DATA');
  url.searchParams.set('usage', 'PLAYBACK');
  for (const format of playbackFormats) {
    url.searchParams.append('formats', format);
  }

  const playbackSessionId = randomUUID();
  const { response } = await executeTidalRequest(
    `Loading TIDAL playback quality for track ${trackId}`,
    async () => {
      const response = await fetchImpl(url, {
        headers: {
          Accept: 'application/vnd.api+json',
          Authorization: `Bearer ${accessToken}`,
          'x-playback-session-id': playbackSessionId,
          'x-tidal-token': clientId,
        },
      });
      if (response.status === 403) {
        throw new NetworkError(
          `TIDAL forbids playback-quality inspection for track ${trackId}.`,
        );
      }
      return {
        error: response.ok
          ? undefined
          : {
              status: response.status,
              title: response.statusText || undefined,
            },
        response,
      };
    },
  );

  const { formats, uri } = readManifestAttributes(await response.json());
  const best = parseDashAudioRepresentations(decodeDashDataUri(uri))
    .filter((representation) =>
      representation.codec.toLowerCase().includes('flac'),
    )
    .sort(
      (left, right) =>
        right.sampleRateHz - left.sampleRateHz ||
        right.bitDepth - left.bitDepth,
    )[0];
  if (best === undefined) {
    throw new NetworkError(
      `TIDAL DASH manifest for track ${trackId} did not include an exact FLAC representation.`,
    );
  }

  return {
    bitDepth: best.bitDepth,
    format: formats.includes('FLAC_HIRES') ? 'FLAC_HIRES' : best.codec,
    sampleRateHz: best.sampleRateHz,
  };
}
