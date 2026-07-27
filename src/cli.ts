import { Command, CommanderError, InvalidArgumentError } from 'commander';

import {
  getAuthStatus,
  login,
  logoutUser,
  type AuthStatus,
} from './auth/service.js';
import { runInit } from './commands/init.js';
import {
  runSearchTracks,
  type SearchTracksHandler,
} from './commands/search.js';
import {
  type SyncHandlers,
  writePullResult,
  writePushResult,
  writeSyncPlan,
} from './commands/sync.js';
import { runValidate } from './commands/validate.js';
import type { TrackReference } from './domain.js';
import { ExitCode, TidekeeperError } from './errors.js';
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
import { searchTracks, type SearchTracksOptions } from './tidal/search.js';

export type CliDependencies = {
  auth?: {
    login(options: { redirectUri?: string }): Promise<AuthStatus>;
    logout(): Promise<void>;
    status(): Promise<AuthStatus>;
  };
  searchTracks?: SearchTracksHandler;
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
