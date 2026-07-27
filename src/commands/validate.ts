import type { OutputFormatValue, OutputStreams } from '../output.js';
import { writeOutput } from '../output.js';
import { loadLibrary } from '../storage/library.js';

export type ValidateOptions = {
  output: OutputFormatValue;
  root: string;
};

export async function runValidate(
  options: ValidateOptions,
  streams: OutputStreams,
): Promise<void> {
  const library = await loadLibrary(options.root);
  const result = {
    favoriteTracks: library.favorites.tracks.length,
    playlists: library.playlists.length,
    status: 'valid',
    tracksInPlaylists: library.playlists.reduce(
      (count, playlist) => count + playlist.tracks.length,
      0,
    ),
  };
  writeOutput(streams.stdout, options.output, result, [result]);
}
