import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/cli.js';
import type { GitHubRepositoryPublishOptions } from '../src/repository/github.js';
import type { SyncPlan } from '../src/sync/plan.js';

class BufferStream extends Writable {
  readonly #chunks: string[] = [];

  public override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#chunks.push(chunk.toString('utf8'));
    callback();
  }

  public override toString(): string {
    return this.#chunks.join('');
  }
}

function createStreams(): {
  stderr: BufferStream;
  stdout: BufferStream;
} {
  return {
    stderr: new BufferStream(),
    stdout: new BufferStream(),
  };
}

describe('CLI', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it('prints help through the injected output stream', async () => {
    const streams = createStreams();

    const exitCode = await runCli(['node', 'tidekeeper', '--help'], {
      streams,
    });

    expect(exitCode).toBe(0);
    expect(streams.stdout.toString()).toContain('Usage: tidekeeper');
    expect(streams.stderr.toString()).toBe('');
  });

  it('returns a usage exit code for an unknown command', async () => {
    const streams = createStreams();

    const exitCode = await runCli(['node', 'tidekeeper', 'unknown'], {
      streams,
    });

    expect(exitCode).toBe(2);
    expect(streams.stderr.toString()).toContain("unknown command 'unknown'");
  });

  it('initializes and validates a library with JSON output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tidekeeper-cli-'));
    temporaryRoots.push(root);
    const streams = createStreams();

    const initExitCode = await runCli(
      [
        'node',
        'tidekeeper',
        '--root',
        root,
        '--output',
        'json',
        'init',
        '--country-code',
        'us',
      ],
      { streams },
    );

    expect(initExitCode).toBe(0);
    expect(JSON.parse(streams.stdout.toString())).toMatchObject({
      status: 'initialized',
    });

    const validateStreams = createStreams();
    const validateExitCode = await runCli(
      ['node', 'tidekeeper', '--root', root, '--output', 'json', 'validate'],
      { streams: validateStreams },
    );

    expect(validateExitCode).toBe(0);
    expect(JSON.parse(validateStreams.stdout.toString())).toEqual({
      favoriteTracks: 0,
      playlists: 0,
      status: 'valid',
      tracksInPlaylists: 0,
    });
  });

  it('reports invalid initialization data as validation failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tidekeeper-cli-'));
    temporaryRoots.push(root);
    const streams = createStreams();

    const exitCode = await runCli(
      [
        'node',
        'tidekeeper',
        '--root',
        root,
        'init',
        '--country-code',
        'INVALID',
      ],
      { streams },
    );

    expect(exitCode).toBe(3);
    expect(streams.stderr.toString()).toContain('countryCode');
  });

  it('creates a repository through injected dependencies without applying remote changes', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'tidekeeper-cli-repository-'));
    temporaryRoots.push(parent);
    const target = join(parent, 'music');
    const streams = createStreams();

    const exitCode = await runCli(
      [
        'node',
        'tidekeeper',
        '--output',
        'json',
        'repo',
        'create',
        target,
        '--country-code',
        'US',
        '--git-name',
        'Tidekeeper Test',
        '--git-email',
        'test@example.com',
      ],
      {
        repository: {
          authStatus: () =>
            Promise.resolve({ authenticated: true, grantedScopes: [] }),
          login: () =>
            Promise.resolve({ authenticated: true, grantedScopes: [] }),
          publish: () =>
            Promise.resolve({
              owner: 'test-user',
              repository: 'test-user/Tidal',
              status: 'published',
              url: 'https://github.com/test-user/Tidal',
              visibility: 'private',
            }),
          remoteSnapshot: (config) =>
            Promise.resolve({
              config,
              favorites: { kind: 'favorites', schemaVersion: 1, tracks: [] },
              playlists: [],
            }),
        },
        streams,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(streams.stdout.toString())).toMatchObject({
      status: 'created',
      target,
      githubRepository: 'test-user/Tidal',
    });
  });

  it('can create a local-only repository without invoking GitHub', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'tidekeeper-cli-repository-'));
    temporaryRoots.push(parent);
    const target = join(parent, 'local-music');
    const streams = createStreams();

    const exitCode = await runCli(
      [
        'node',
        'tidekeeper',
        '--output',
        'json',
        'repo',
        'create',
        target,
        '--country-code',
        'US',
        '--git-name',
        'Tidekeeper Test',
        '--git-email',
        'test@example.com',
        '--no-github',
      ],
      {
        repository: {
          authStatus: () =>
            Promise.resolve({ authenticated: true, grantedScopes: [] }),
          login: () =>
            Promise.resolve({ authenticated: true, grantedScopes: [] }),
          publish: () => {
            throw new Error('GitHub publishing should be disabled');
          },
          remoteSnapshot: (config) =>
            Promise.resolve({
              config,
              favorites: { kind: 'favorites', schemaVersion: 1, tracks: [] },
              playlists: [],
            }),
        },
        streams,
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(streams.stdout.toString())).toMatchObject({
      githubRepository: null,
      githubUrl: null,
      githubVisibility: null,
      status: 'created',
      target,
    });
  });

  it('passes GitHub publishing overrides to the retryable publish command', async () => {
    const streams = createStreams();
    let receivedOptions: GitHubRepositoryPublishOptions | undefined;

    const exitCode = await runCli(
      [
        'node',
        'tidekeeper',
        '--root',
        'X:\\Music',
        '--output',
        'json',
        'repo',
        'publish',
        '--github-repo',
        'MyMusic',
        '--github-visibility',
        'public',
      ],
      {
        repository: {
          authStatus: () =>
            Promise.resolve({ authenticated: true, grantedScopes: [] }),
          login: () =>
            Promise.resolve({ authenticated: true, grantedScopes: [] }),
          publish: (options) => {
            receivedOptions = options;
            return Promise.resolve({
              owner: 'kboom',
              repository: 'kboom/MyMusic',
              status: 'published',
              url: 'https://github.com/kboom/MyMusic',
              visibility: 'public',
            });
          },
          remoteSnapshot: () => {
            throw new Error('TIDAL should not be read during publishing');
          },
        },
        streams,
      },
    );

    expect(exitCode).toBe(0);
    expect(receivedOptions).toEqual({
      repositoryName: 'MyMusic',
      root: 'X:\\Music',
      visibility: 'public',
    });
    expect(JSON.parse(streams.stdout.toString())).toMatchObject({
      repository: 'kboom/MyMusic',
      status: 'published',
      visibility: 'public',
    });
  });

  it('prints injected search results as JSON Lines for agents', async () => {
    const streams = createStreams();
    let receivedQuery = '';
    let receivedLimit: number | undefined;

    const exitCode = await runCli(
      [
        'node',
        'tidekeeper',
        '--output',
        'jsonl',
        'search',
        'tracks',
        'kind of blue',
        '--limit',
        '1',
      ],
      {
        searchTracks: (query, options) => {
          receivedQuery = query;
          receivedLimit = options.limit;
          return Promise.resolve([
            {
              album: 'Kind of Blue',
              artists: ['Miles Davis'],
              id: 'track-1',
              title: 'So What',
            },
          ]);
        },
        streams,
      },
    );

    expect(exitCode).toBe(0);
    expect(receivedQuery).toBe('kind of blue');
    expect(receivedLimit).toBe(1);
    expect(streams.stdout.toString()).toBe(
      `${JSON.stringify({
        album: 'Kind of Blue',
        artists: ['Miles Davis'],
        id: 'track-1',
        title: 'So What',
      })}\n`,
    );
    expect(streams.stderr.toString()).toBe('');
  });

  it('rejects an invalid search limit before invoking TIDAL', async () => {
    const streams = createStreams();
    let invoked = false;

    const exitCode = await runCli(
      ['node', 'tidekeeper', 'search', 'tracks', 'query', '--limit', '0'],
      {
        searchTracks: () => {
          invoked = true;
          return Promise.resolve([]);
        },
        streams,
      },
    );

    expect(exitCode).toBe(2);
    expect(invoked).toBe(false);
    expect(streams.stderr.toString()).toContain('Expected a positive integer');
  });

  it('keeps sync push as a plan-only dry run unless apply is explicit', async () => {
    const streams = createStreams();
    const plan = syncPlan({
      hasRemovals: true,
      operations: [{ kind: 'favorites.remove', trackIds: ['track-1'] }],
    });
    let planCalls = 0;
    let pushCalls = 0;

    const exitCode = await runCli(
      [
        'node',
        'tidekeeper',
        '--output',
        'json',
        'sync',
        'push',
        '--allow-removals',
      ],
      {
        streams,
        sync: {
          plan: () => {
            planCalls += 1;
            return Promise.resolve(plan);
          },
          pull: () =>
            Promise.resolve({
              applied: false,
              changed: false,
              remoteFingerprint: 'remote',
            }),
          push: () => {
            pushCalls += 1;
            return Promise.resolve({ appliedOperations: 1, plan });
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(planCalls).toBe(1);
    expect(pushCalls).toBe(0);
    expect(JSON.parse(streams.stdout.toString())).toEqual(plan);
  });

  it('passes explicit push safety flags to the apply handler', async () => {
    const streams = createStreams();
    const plan = syncPlan();
    let receivedOptions:
      { allowDirty?: boolean; allowRemovals?: boolean } | undefined;

    const exitCode = await runCli(
      [
        'node',
        'tidekeeper',
        '--output',
        'json',
        'sync',
        'push',
        '--apply',
        '--allow-removals',
        '--allow-dirty',
      ],
      {
        streams,
        sync: {
          plan: () => Promise.resolve(plan),
          pull: () =>
            Promise.resolve({
              applied: false,
              changed: false,
              remoteFingerprint: 'remote',
            }),
          push: (_root, options) => {
            receivedOptions = options;
            return Promise.resolve({ appliedOperations: 0, plan });
          },
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(receivedOptions).toEqual({
      allowDirty: true,
      allowRemovals: true,
    });
  });

  it('emits one JSON Lines record for object-shaped command results', async () => {
    const streams = createStreams();

    const exitCode = await runCli(
      ['node', 'tidekeeper', '--output', 'jsonl', 'auth', 'status'],
      {
        auth: {
          login: () =>
            Promise.resolve({
              authenticated: true,
              grantedScopes: ['r_usr', 'w_usr'],
              userId: 'user-1',
            }),
          logout: () => Promise.resolve(),
          status: () =>
            Promise.resolve({
              authenticated: true,
              grantedScopes: ['r_usr', 'w_usr'],
              userId: 'user-1',
            }),
        },
        streams,
      },
    );

    expect(exitCode).toBe(0);
    expect(streams.stdout.toString()).toBe(
      `${JSON.stringify({
        authenticated: true,
        grantedScopes: ['r_usr', 'w_usr'],
        userId: 'user-1',
      })}\n`,
    );
  });
});

function syncPlan(overrides: Partial<SyncPlan> = {}): SyncPlan {
  return {
    digest: 'digest',
    hasRemovals: false,
    localFingerprint: 'local',
    operations: [],
    remoteFingerprint: 'remote',
    ...overrides,
  };
}
