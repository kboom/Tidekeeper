import { Command, CommanderError, InvalidArgumentError } from 'commander';

import {
  getAuthStatus,
  getInitializedCredentialsProvider,
  login,
  logoutUser,
  type AuthStatus,
} from './auth/service.js';
import { runInit } from './commands/init.js';
import {
  runFavoritesAdd,
  runFavoritesRemove,
  runLibrarySummary,
  runPlaylistCreate,
  runPlaylistDelete,
  runPlaylistSetTracks,
  runPlaylistUpdate,
} from './commands/library.js';
import {
  runRepositoryCreate,
  runRepositoryPublish,
  runRepositoryUpgrade,
  runRepositoryVerify,
} from './commands/repository.js';
import {
  runSearchTracks,
  type SearchTracksHandler,
} from './commands/search.js';
import {
  runInspectTracks,
  runRelatedTracks,
  type InspectTracksHandler,
  type RelatedTracksHandler,
} from './commands/tracks.js';
import {
  type SyncHandlers,
  writePullResult,
  writePushResult,
  writeSyncPlan,
} from './commands/sync.js';
import { runValidate } from './commands/validate.js';
import type { TrackReference } from './domain.js';
import { AuthenticationError, ExitCode, TidekeeperError } from './errors.js';
import {
  defaultStreams,
  OutputFormat,
  parseOutputFormat,
  type OutputFormatValue,
  type OutputStreams,
  writeDiagnostic,
  writeOutput,
} from './output.js';
import { planPush, pullRemote, pushLocal } from './sync/service.js';
import { createAuthenticatedTidalClient } from './tidal/authenticated.js';
import { createTidalClient } from './tidal/client.js';
import {
  inspectTrackQuality,
  type InspectTracksOptions,
  loadPlaybackAudioQuality,
} from './tidal/quality.js';
import {
  findRelatedTracks,
  type RelatedTracksOptions,
} from './tidal/related.js';
import { searchTracks, type SearchTracksOptions } from './tidal/search.js';
import type { RepositoryCreateDependencies } from './repository/service.js';
import type { GitHubRepositoryVisibility } from './repository/github.js';

export type CliDependencies = {
  auth?: {
    login(options: { redirectUri?: string }): Promise<AuthStatus>;
    logout(): Promise<void>;
    status(): Promise<AuthStatus>;
  };
  inspectTracks?: InspectTracksHandler;
  relatedTracks?: RelatedTracksHandler;
  searchTracks?: SearchTracksHandler;
  repository?: RepositoryCreateDependencies;
  streams: OutputStreams;
  sync?: SyncHandlers;
};

export function createProgram(
  dependencies: CliDependencies = { streams: defaultStreams },
): Command {
  const program = new Command()
    .name('tidekeeper')
    .description(
      'Synchronize a TIDAL library with version-controlled files and search tracks.',
    )
    .version('0.1.0')
    .option('-r, --root <path>', 'Tidekeeper repository root', process.cwd())
    .option(
      '--output <format>',
      'output format: table, json, or jsonl',
      (value) => parseOutputFormat(value),
      OutputFormat.table,
    )
    .configureOutput({
      writeErr: (text) => dependencies.streams.stderr.write(text),
      writeOut: (text) => dependencies.streams.stdout.write(text),
    })
    .showHelpAfterError()
    .showSuggestionAfterError();

  const auth = program
    .command('auth')
    .description('Authenticate Tidekeeper with TIDAL');

  auth
    .command('login')
    .description('Authorize Tidekeeper through the system browser')
    .option('--redirect-uri <uri>', 'registered HTTP loopback redirect URI')
    .action(async (options: { redirectUri?: string }) => {
      const globalOptions = program.opts<{ output: OutputFormatValue }>();
      const status = await (dependencies.auth?.login ?? login)({
        ...(options.redirectUri ? { redirectUri: options.redirectUri } : {}),
      });
      writeAuthStatus(dependencies.streams, globalOptions.output, status);
    });

  auth
    .command('status')
    .description('Show the current TIDAL authentication status')
    .action(async () => {
      const globalOptions = program.opts<{ output: OutputFormatValue }>();
      const status = await (dependencies.auth?.status ?? getAuthStatus)();
      writeAuthStatus(dependencies.streams, globalOptions.output, status);
    });

  auth
    .command('logout')
    .description('Remove the local TIDAL session from the OS credential store')
    .action(async () => {
      const globalOptions = program.opts<{ output: OutputFormatValue }>();
      await (dependencies.auth?.logout ?? logoutUser)();
      writeOutput(
        dependencies.streams.stdout,
        globalOptions.output,
        { authenticated: false },
        [{ authenticated: false }],
      );
    });

  const search = program
    .command('search')
    .description('Search the TIDAL catalog');

  search
    .command('tracks')
    .description('Print every track matching a query')
    .argument('<query>', 'track search query')
    .option('--country-code <code>', 'ISO 3166-1 alpha-2 country code')
    .option(
      '--explicit-filter <mode>',
      'explicit content filter: include or exclude',
      parseExplicitFilter,
    )
    .option(
      '--limit <number>',
      'stop after this many matches',
      parsePositiveInteger,
    )
    .action(
      async (
        query: string,
        options: {
          countryCode?: string;
          explicitFilter?: 'INCLUDE' | 'EXCLUDE';
          limit?: number;
        },
      ) => {
        const globalOptions = program.opts<{ output: OutputFormatValue }>();
        await runSearchTracks(
          query,
          {
            ...(options.countryCode
              ? { countryCode: options.countryCode.toUpperCase() }
              : {}),
            ...(options.explicitFilter
              ? { explicitFilter: options.explicitFilter }
              : {}),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
            output: globalOptions.output,
          },
          dependencies.streams,
          dependencies.searchTracks ?? searchTracksWithDefaultClient,
        );
      },
    );

  const tracks = program
    .command('tracks')
    .description('Inspect TIDAL track metadata');

  tracks
    .command('inspect')
    .description(
      'Inspect exact audio quality for tracks from a JSON array file',
    )
    .requiredOption(
      '--tracks-file <path>',
      'JSON file containing track objects',
    )
    .option(
      '--media-tag <tag>',
      'prefilter candidates by TIDAL media tag',
      'HIRES_LOSSLESS',
    )
    .option(
      '--min-bit-depth <number>',
      'minimum exact bit depth',
      parsePositiveInteger,
      24,
    )
    .option(
      '--min-sample-rate <number>',
      'minimum exact sample rate in Hz',
      parsePositiveInteger,
      80_000,
    )
    .action(
      async (options: {
        mediaTag: string;
        minBitDepth: number;
        minSampleRate: number;
        tracksFile: string;
      }) => {
        const globalOptions = program.opts<{ output: OutputFormatValue }>();
        await runInspectTracks(
          options.tracksFile,
          {
            mediaTag: options.mediaTag,
            minBitDepth: options.minBitDepth,
            minSampleRateHz: options.minSampleRate,
            output: globalOptions.output,
          },
          dependencies.streams,
          dependencies.inspectTracks ?? inspectTracksWithDefaultClient,
        );
      },
    );

  tracks
    .command('related')
    .description('Find tracks from the same albums or artists as seed tracks')
    .requiredOption(
      '--tracks-file <path>',
      'JSON file containing seed track objects',
    )
    .requiredOption(
      '--by <relation>',
      'relationship to expand: album or artist',
      parseRelatedTrackSource,
    )
    .option(
      '--limit-per-source <number>',
      'maximum tracks returned from each album or artist',
      parsePositiveInteger,
      50,
    )
    .action(
      async (options: {
        by: RelatedTracksOptions['by'];
        limitPerSource: number;
        tracksFile: string;
      }) => {
        const globalOptions = program.opts<{ output: OutputFormatValue }>();
        await runRelatedTracks(
          options.tracksFile,
          {
            by: options.by,
            limitPerSource: options.limitPerSource,
            output: globalOptions.output,
          },
          dependencies.streams,
          dependencies.relatedTracks ?? relatedTracksWithDefaultClient,
        );
      },
    );

  const sync = program
    .command('sync')
    .description('Synchronize the local library with TIDAL');

  sync
    .command('pull')
    .description('Preview or apply TIDAL-to-disk changes')
    .option('--apply', 'write the remote snapshot to disk', false)
    .option(
      '--force',
      'overwrite uncommitted managed files when applying',
      false,
    )
    .action(async (options: { apply: boolean; force: boolean }) => {
      const globalOptions = program.opts<{
        output: OutputFormatValue;
        root: string;
      }>();
      const result = await (
        dependencies.sync?.pull ?? defaultSyncHandlers.pull
      )(globalOptions.root, options.apply, options.force);
      writePullResult(result, globalOptions.output, dependencies.streams);
    });

  sync
    .command('plan')
    .description('Print the exact disk-to-TIDAL operation plan')
    .action(async () => {
      const globalOptions = program.opts<{
        output: OutputFormatValue;
        root: string;
      }>();
      const plan = await (dependencies.sync?.plan ?? defaultSyncHandlers.plan)(
        globalOptions.root,
      );
      writeSyncPlan(plan, globalOptions.output, dependencies.streams);
    });

  sync
    .command('push')
    .description('Preview or apply disk-to-TIDAL changes')
    .option('--apply', 'apply the displayed operation plan to TIDAL', false)
    .option(
      '--allow-removals',
      'allow operations that remove remote favorites, playlists, or items',
      false,
    )
    .option('--allow-dirty', 'allow applying uncommitted managed files', false)
    .action(
      async (options: {
        allowDirty: boolean;
        allowRemovals: boolean;
        apply: boolean;
      }) => {
        const globalOptions = program.opts<{
          output: OutputFormatValue;
          root: string;
        }>();
        if (!options.apply) {
          const plan = await (
            dependencies.sync?.plan ?? defaultSyncHandlers.plan
          )(globalOptions.root);
          writeSyncPlan(plan, globalOptions.output, dependencies.streams);
          return;
        }

        const result = await (
          dependencies.sync?.push ?? defaultSyncHandlers.push
        )(globalOptions.root, {
          allowDirty: options.allowDirty,
          allowRemovals: options.allowRemovals,
        });
        writePushResult(result, globalOptions.output, dependencies.streams);
      },
    );

  program
    .command('init')
    .description('Initialize a version-controlled Tidekeeper library')
    .option(
      '--country-code <code>',
      'ISO 3166-1 alpha-2 country code used for TIDAL catalog requests',
    )
    .option('--force', 'replace an existing Tidekeeper configuration', false)
    .action(async (options: { countryCode?: string; force: boolean }) => {
      const globalOptions = program.opts<{
        output: OutputFormatValue;
        root: string;
      }>();
      await runInit(
        {
          ...(options.countryCode === undefined
            ? {}
            : { countryCode: options.countryCode.toUpperCase() }),
          force: options.force,
          output: globalOptions.output,
          root: globalOptions.root,
        },
        dependencies.streams,
      );
    });

  const repository = program
    .command('repo')
    .description('Create and maintain an agent-ready music repository');

  repository
    .command('create')
    .description('Create, import, and commit a new TIDAL music repository')
    .argument('<directory>', 'new repository directory')
    .requiredOption(
      '--country-code <code>',
      'ISO 3166-1 alpha-2 country code used for TIDAL catalog requests',
    )
    .option(
      '--ephemeral-session',
      'keep OAuth credentials in memory for this command only',
      false,
    )
    .option(
      '--git-name <name>',
      'Git author name to configure for this repository',
    )
    .option(
      '--git-email <email>',
      'Git author email to configure for this repository',
    )
    .option('--github-repo <name>', 'personal GitHub repository name', 'Tidal')
    .option(
      '--github-visibility <visibility>',
      'GitHub repository visibility: private or public',
      (value) => parseGitHubVisibility(value),
      'private',
    )
    .option('--no-github', 'create only the local Git repository')
    .action(
      async (
        directory: string,
        options: {
          countryCode: string;
          ephemeralSession: boolean;
          gitEmail?: string;
          gitName?: string;
          github: boolean;
          githubRepo: string;
          githubVisibility: GitHubRepositoryVisibility;
        },
      ) => {
        const globalOptions = program.opts<{ output: OutputFormatValue }>();
        await runRepositoryCreate(
          {
            countryCode: options.countryCode.toUpperCase(),
            ephemeralSession: options.ephemeralSession,
            ...(options.gitEmail === undefined
              ? {}
              : { gitEmail: options.gitEmail }),
            ...(options.gitName === undefined
              ? {}
              : { gitName: options.gitName }),
            github: options.github,
            githubRepository: options.githubRepo,
            githubVisibility: options.githubVisibility,
            output: globalOptions.output,
            target: directory,
          },
          dependencies.streams,
          dependencies.repository,
        );
      },
    );

  repository
    .command('publish')
    .description('Create and push a personal GitHub repository')
    .argument('[directory]', 'local Tidekeeper repository directory')
    .option('--github-repo <name>', 'personal GitHub repository name', 'Tidal')
    .option(
      '--github-visibility <visibility>',
      'GitHub repository visibility: private or public',
      (value) => parseGitHubVisibility(value),
      'private',
    )
    .action(
      async (
        directory: string | undefined,
        options: {
          githubRepo: string;
          githubVisibility: GitHubRepositoryVisibility;
        },
      ) => {
        const globalOptions = program.opts<{
          output: OutputFormatValue;
          root: string;
        }>();
        const repositoryDependencies = dependencies.repository;
        await runRepositoryPublish(
          {
            output: globalOptions.output,
            repositoryName: options.githubRepo,
            root: directory ?? globalOptions.root,
            visibility: options.githubVisibility,
          },
          dependencies.streams,
          repositoryDependencies === undefined
            ? undefined
            : (publishOptions) =>
                repositoryDependencies.publish(publishOptions),
        );
      },
    );

  repository
    .command('verify')
    .description('Verify generated repository assets and local music data')
    .action(async () => {
      const globalOptions = program.opts<{
        output: OutputFormatValue;
        root: string;
      }>();
      await runRepositoryVerify(globalOptions, dependencies.streams);
    });

  repository
    .command('upgrade')
    .description('Update unmodified generated repository assets safely')
    .action(async () => {
      const globalOptions = program.opts<{
        output: OutputFormatValue;
        root: string;
      }>();
      await runRepositoryUpgrade(globalOptions, dependencies.streams);
    });

  const library = program
    .command('library')
    .description('Safely inspect and edit the local music library');

  library
    .command('summary')
    .description('Print a machine-readable local library summary')
    .action(async () => {
      const globalOptions = program.opts<{
        output: OutputFormatValue;
        root: string;
      }>();
      await runLibrarySummary(
        globalOptions.root,
        globalOptions.output,
        dependencies.streams,
      );
    });

  const playlist = library
    .command('playlist')
    .description('Edit local playlists without hand-writing YAML');

  playlist
    .command('create')
    .description('Create an empty local playlist')
    .argument('<title>', 'playlist title')
    .option('--description <text>', 'playlist description', '')
    .action(async (title: string, options: { description: string }) => {
      const globalOptions = program.opts<{
        output: OutputFormatValue;
        root: string;
      }>();
      await runPlaylistCreate(
        globalOptions.root,
        title,
        options.description,
        globalOptions.output,
        dependencies.streams,
      );
    });

  playlist
    .command('update')
    .description('Update a playlist title or description')
    .argument('<id>', 'TIDAL or local playlist ID')
    .option('--title <title>', 'new playlist title')
    .option('--description <text>', 'new playlist description')
    .action(
      async (id: string, options: { description?: string; title?: string }) => {
        const globalOptions = program.opts<{
          output: OutputFormatValue;
          root: string;
        }>();
        await runPlaylistUpdate(
          globalOptions.root,
          id,
          options,
          globalOptions.output,
          dependencies.streams,
        );
      },
    );

  playlist
    .command('set-tracks')
    .description('Replace playlist tracks from a JSON array file')
    .argument('<id>', 'TIDAL or local playlist ID')
    .requiredOption(
      '--tracks-file <path>',
      'JSON file containing track objects',
    )
    .action(async (id: string, options: { tracksFile: string }) => {
      const globalOptions = program.opts<{
        output: OutputFormatValue;
        root: string;
      }>();
      await runPlaylistSetTracks(
        globalOptions.root,
        id,
        options.tracksFile,
        globalOptions.output,
        dependencies.streams,
      );
    });

  playlist
    .command('delete')
    .description('Delete a local playlist')
    .argument('<id>', 'TIDAL or local playlist ID')
    .action(async (id: string) => {
      const globalOptions = program.opts<{
        output: OutputFormatValue;
        root: string;
      }>();
      await runPlaylistDelete(
        globalOptions.root,
        id,
        globalOptions.output,
        dependencies.streams,
      );
    });

  const favorites = library
    .command('favorites')
    .description('Edit local favorite tracks without hand-writing YAML');

  favorites
    .command('add')
    .description('Add favorite tracks from a JSON array file')
    .requiredOption(
      '--tracks-file <path>',
      'JSON file containing track objects',
    )
    .action(async (options: { tracksFile: string }) => {
      const globalOptions = program.opts<{
        output: OutputFormatValue;
        root: string;
      }>();
      await runFavoritesAdd(
        globalOptions.root,
        options.tracksFile,
        globalOptions.output,
        dependencies.streams,
      );
    });

  favorites
    .command('remove')
    .description('Remove local favorites by TIDAL track ID')
    .argument('<track-ids...>', 'one or more TIDAL track IDs')
    .action(async (trackIds: string[]) => {
      const globalOptions = program.opts<{
        output: OutputFormatValue;
        root: string;
      }>();
      await runFavoritesRemove(
        globalOptions.root,
        trackIds,
        globalOptions.output,
        dependencies.streams,
      );
    });

  program
    .command('validate')
    .description(
      'Validate the local Tidekeeper configuration and library files',
    )
    .action(async () => {
      const globalOptions = program.opts<{
        output: OutputFormatValue;
        root: string;
      }>();
      await runValidate(
        {
          output: globalOptions.output,
          root: globalOptions.root,
        },
        dependencies.streams,
      );
    });

  return program;
}

async function searchTracksWithDefaultClient(
  query: string,
  options: SearchTracksOptions,
): Promise<TrackReference[]> {
  return searchTracks(await createAuthenticatedTidalClient(), query, options);
}

async function inspectTracksWithDefaultClient(
  tracks: readonly TrackReference[],
  options: InspectTracksOptions,
) {
  const credentialsProvider = await getInitializedCredentialsProvider();
  return inspectTrackQuality(
    createTidalClient({ credentialsProvider }),
    tracks,
    options,
    async (trackId) => {
      const credentials = await credentialsProvider.getCredentials();
      if (!credentials.token) {
        throw new AuthenticationError(
          'The stored TIDAL session has no access token. Log in again.',
        );
      }
      return loadPlaybackAudioQuality(
        credentials.token,
        credentials.clientId,
        trackId,
      );
    },
  );
}

async function relatedTracksWithDefaultClient(
  tracks: readonly TrackReference[],
  options: RelatedTracksOptions,
): Promise<TrackReference[]> {
  return findRelatedTracks(
    await createAuthenticatedTidalClient(),
    tracks,
    options,
  );
}

const defaultSyncHandlers: SyncHandlers = {
  plan: async (root) => planPush(await createAuthenticatedTidalClient(), root),
  pull: async (root, apply, force) =>
    pullRemote(await createAuthenticatedTidalClient(), root, apply, force),
  push: async (root, options) =>
    pushLocal(await createAuthenticatedTidalClient(), root, options),
};

function writeAuthStatus(
  streams: OutputStreams,
  output: OutputFormatValue,
  status: AuthStatus,
): void {
  writeOutput(streams.stdout, output, status, [
    {
      authenticated: status.authenticated,
      expiresAt: status.expiresAt ?? '',
      grantedScopes: status.grantedScopes.join(', '),
      userId: status.userId ?? '',
    },
  ]);
}

function parsePositiveInteger(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new InvalidArgumentError('Expected a positive integer.');
  }
  return Number(value);
}

function parseExplicitFilter(value: string): 'INCLUDE' | 'EXCLUDE' {
  const normalized = value.toUpperCase();
  if (normalized !== 'INCLUDE' && normalized !== 'EXCLUDE') {
    throw new InvalidArgumentError('Expected "include" or "exclude".');
  }
  return normalized;
}

function parseRelatedTrackSource(value: string): RelatedTracksOptions['by'] {
  if (value === 'album' || value === 'artist') {
    return value;
  }
  throw new InvalidArgumentError('Expected album or artist.');
}

function parseGitHubVisibility(value: string): GitHubRepositoryVisibility {
  const normalized = value.toLowerCase();
  if (normalized !== 'private' && normalized !== 'public') {
    throw new InvalidArgumentError('Expected "private" or "public".');
  }
  return normalized;
}

export async function runCli(
  argv: readonly string[] = process.argv,
  dependencies: CliDependencies = { streams: defaultStreams },
): Promise<number> {
  const program = createProgram(dependencies);
  configureExitOverrides(program);

  try {
    await program.parseAsync([...argv]);
    return ExitCode.success;
  } catch (error: unknown) {
    if (error instanceof CommanderError) {
      if (
        error.code === 'commander.helpDisplayed' ||
        error.code === 'commander.version'
      ) {
        return ExitCode.success;
      }
      process.exitCode = ExitCode.usage;
      return ExitCode.usage;
    }

    if (error instanceof TidekeeperError) {
      writeDiagnostic(dependencies.streams.stderr, error.message);
      process.exitCode = error.exitCode;
      return error.exitCode;
    }

    const message =
      error instanceof Error ? error.message : 'An unexpected error occurred.';
    writeDiagnostic(dependencies.streams.stderr, message);
    process.exitCode = ExitCode.unexpected;
    return ExitCode.unexpected;
  }
}

function configureExitOverrides(command: Command): void {
  command.exitOverride();
  for (const subcommand of command.commands) {
    configureExitOverrides(subcommand);
  }
}
