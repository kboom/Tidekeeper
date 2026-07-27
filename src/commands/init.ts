import type { OutputFormatValue, OutputStreams } from '../output.js';
import { writeOutput } from '../output.js';
import { initializeLibrary } from '../storage/library.js';

export type InitOptions = {
  countryCode?: string;
  force: boolean;
  output: OutputFormatValue;
  root: string;
};

export async function runInit(
  options: InitOptions,
  streams: OutputStreams,
): Promise<void> {
  const paths = await initializeLibrary(
    options.root,
    options.countryCode,
    options.force,
  );
  const result = {
    config: paths.config,
    library: paths.library,
    status: 'initialized',
  };
  writeOutput(streams.stdout, options.output, result, [
    {
      config: paths.config,
      library: paths.library,
      status: 'initialized',
    },
  ]);
}
