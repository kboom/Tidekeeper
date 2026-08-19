import type { TrackReference } from '../domain.js';
import type { OutputFormatValue, OutputStreams } from '../output.js';
import { writeOutput } from '../output.js';
import { readTracksFile } from './library.js';
import type {
  InspectTracksOptions,
  TrackInspectionResult,
} from '../tidal/quality.js';
import type { RelatedTracksOptions } from '../tidal/related.js';

export type InspectTracksHandler = (
  tracks: readonly TrackReference[],
  options: InspectTracksOptions,
) => Promise<TrackInspectionResult>;

export type RelatedTracksHandler = (
  tracks: readonly TrackReference[],
  options: RelatedTracksOptions,
) => Promise<TrackReference[]>;

export async function runInspectTracks(
  tracksFile: string,
  options: InspectTracksOptions & { output: OutputFormatValue },
  streams: OutputStreams,
  inspect: InspectTracksHandler,
): Promise<void> {
  const result = await inspect(await readTracksFile(tracksFile), options);
  writeOutput(
    streams.stdout,
    options.output,
    result,
    result.tracks.map((track) => ({
      artists: track.artists.join(', '),
      bitDepth: track.audio?.bitDepth ?? '',
      id: track.id,
      sampleRateHz: track.audio?.sampleRateHz ?? '',
      title: track.title,
    })),
  );
}

export async function runRelatedTracks(
  tracksFile: string,
  options: RelatedTracksOptions & { output: OutputFormatValue },
  streams: OutputStreams,
  findRelated: RelatedTracksHandler,
): Promise<void> {
  const tracks = await findRelated(await readTracksFile(tracksFile), {
    by: options.by,
    limitPerSource: options.limitPerSource,
  });
  writeOutput(
    streams.stdout,
    options.output,
    tracks,
    tracks.map((track) => ({
      album: track.album ?? '',
      artists: track.artists.join(', '),
      id: track.id,
      title: track.title,
    })),
  );
}
