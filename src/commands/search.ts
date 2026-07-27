import type { TrackReference } from '../domain.js';
import type { OutputFormatValue, OutputStreams } from '../output.js';
import { writeOutput } from '../output.js';
import type { SearchTracksOptions } from '../tidal/search.js';

export type SearchTracksCommandOptions = {
  output: OutputFormatValue;
} & SearchTracksOptions;

export type SearchTracksHandler = (
  query: string,
  options: SearchTracksOptions,
) => Promise<TrackReference[]>;

export async function runSearchTracks(
  query: string,
  options: SearchTracksCommandOptions,
  streams: OutputStreams,
  search: SearchTracksHandler,
): Promise<void> {
  const tracks = await search(query, {
    ...(options.countryCode ? { countryCode: options.countryCode } : {}),
    ...(options.explicitFilter
      ? { explicitFilter: options.explicitFilter }
      : {}),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });

  writeOutput(
    streams.stdout,
    options.output,
    tracks,
    tracks.map((track) => ({
      album: track.album ?? '',
      artists: track.artists.join(', '),
      durationSeconds: track.durationSeconds ?? '',
      explicit: track.explicit ?? false,
      id: track.id,
      title: track.title,
    })),
  );
}
