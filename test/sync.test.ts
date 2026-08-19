import { execFile } from 'node:child_process';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFile, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { CredentialsProvider } from '@tidal-music/common';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  FavoritesDocument,
  LibrarySnapshot,
  PlaylistDocument,
} from '../src/domain.js';
import { ConflictError, PartialApplyError } from '../src/errors.js';
import {
  createLibraryPaths,
  initializeLibrary,
  loadLibrary,
  writeLibrarySnapshot,
} from '../src/storage/library.js';
import {
  favoritesDocumentSchema,
  tidekeeperConfigSchema,
} from '../src/storage/schema.js';
import { pathExists, writeYamlFileAtomic } from '../src/storage/yaml.js';
import { savePushJournal } from '../src/sync/journal.js';
import { withSyncLock } from '../src/sync/lock.js';
import {
  buildSyncPlan,
  fingerprintSnapshot,
  fingerprintSnapshotContent,
} from '../src/sync/plan.js';
import { pushLocal } from '../src/sync/service.js';
import { createTidalClient } from '../src/tidal/client.js';

const execFileAsync = promisify(execFile);
const credentialsProvider: CredentialsProvider = {
  bus: () => undefined,
  getCredentials: () =>
    Promise.resolve({
      clientId: 'test-client',
      requestedScopes: [],
      token: 'test-token',
    }),
};

describe('sync planning', () => {
  it('builds a deterministic plan for all supported library changes', () => {
    const remote = snapshot({
      favoriteIds: ['favorite-remove'],
      playlists: [
        playlist('delete', 'Delete me', ['track-1']),
        playlist('update', 'Old title', ['track-1', 'track-2']),
      ],
    });
    const local = snapshot({
      favoriteIds: ['favorite-add'],
      playlists: [
        {
          ...playlist('update', 'New title', ['track-2', 'track-1']),
          description: 'Updated',
        },
        {
          description: 'Draft',
          id: null,
          kind: 'playlist',
          localId: '6d27c06c-18ce-46bb-a1ed-c0064bee7562',
          schemaVersion: 1,
          title: 'Create me',
          tracks: [track('track-3')],
        },
      ],
    });

    const first = buildSyncPlan(local, remote);
    const second = buildSyncPlan(local, remote);

    expect(first).toEqual(second);
    expect(first.hasRemovals).toBe(true);
    expect(first.operations.map((operation) => operation.kind)).toEqual([
      'favorites.remove',
      'favorites.add',
      'playlist.delete',
      'playlist.update',
      'playlist.replaceTracks',
      'playlist.create',
    ]);
  });

  it('ignores readable track annotation changes', () => {
    const remote = snapshot({
      favoriteIds: ['track-1'],
      playlists: [playlist('same', 'Same', ['track-1'])],
    });
    const local = structuredClone(remote);
    const favorite = local.favorites.tracks[0];
    const localPlaylist = local.playlists[0];
    const playlistTrack = localPlaylist?.tracks[0];
    if (!favorite || !localPlaylist || !playlistTrack) {
      throw new Error('Expected sync fixture tracks.');
    }
    local.favorites.tracks[0] = {
      ...favorite,
      album: 'Locally annotated album',
    };
    localPlaylist.tracks[0] = {
      ...playlistTrack,
      title: 'Locally annotated title',
    };

    expect(buildSyncPlan(local, remote).operations).toEqual([]);
  });

  it('preserves local-only unavailable assignments without pushing them', () => {
    const local = snapshot({
      favoriteIds: [],
      playlists: [
        {
          description: '',
          id: null,
          kind: 'playlist',
          localId: '6d27c06c-18ce-46bb-a1ed-c0064bee7562',
          schemaVersion: 1,
          title: 'Local',
          tracks: [
            { ...track('missing'), unavailable: true },
            track('available'),
          ],
        },
      ],
    });

    const create = buildSyncPlan(
      local,
      snapshot({ favoriteIds: [], playlists: [] }),
    ).operations[0];
    expect(create).toMatchObject({
      kind: 'playlist.create',
      trackIds: ['available'],
    });

    const mapped = structuredClone(local);
    const mappedPlaylist = mapped.playlists[0];
    if (!mappedPlaylist) {
      throw new Error('Expected mapped playlist fixture.');
    }
    mappedPlaylist.id = 'remote-playlist';
    const remote = snapshot({
      favoriteIds: [],
      playlists: [playlist('remote-playlist', 'Local', ['available'])],
    });
    expect(buildSyncPlan(mapped, remote).operations).toEqual([]);
    const persisted = structuredClone(remote);
    persisted.playlists[0]?.tracks.unshift({
      ...track('missing'),
      unavailable: true,
    });
    expect(fingerprintSnapshot(persisted)).toBe(fingerprintSnapshot(remote));
  });

  it('blocks a track-list rewrite that could remove unavailable playlist items', () => {
    const remote = snapshot({
      favoriteIds: [],
      playlists: [playlist('protected', 'Protected', ['available', 'missing'])],
    });
    const unavailable = remote.playlists[0]?.tracks[1];
    if (!unavailable) {
      throw new Error('Expected unavailable playlist fixture track.');
    }
    (unavailable as { unavailable?: boolean }).unavailable = true;
    const local = structuredClone(remote);
    const localPlaylist = local.playlists[0];
    if (!localPlaylist) {
      throw new Error('Expected local playlist fixture.');
    }
    const availableTrack = localPlaylist.tracks[0];
    if (!availableTrack) {
      throw new Error('Expected available playlist fixture track.');
    }
    localPlaylist.tracks = [availableTrack];

    expect(() => buildSyncPlan(local, remote)).toThrow(
      /contains unavailable TIDAL track metadata/,
    );
  });
});

describe('resumable push', () => {
  const roots: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all([
      ...roots
        .splice(0)
        .map((root) => rm(root, { force: true, recursive: true })),
      ...servers.splice(0).map((server) => closeServer(server)),
    ]);
  });

  it('journals playlist deletions containing unavailable tracks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tidekeeper-journal-'));
    roots.push(root);
    const remote = snapshot({
      favoriteIds: [],
      playlists: [playlist('delete', 'Delete me', ['missing'])],
    });
    const unavailable = remote.playlists[0]?.tracks[0];
    if (!unavailable) {
      throw new Error('Expected unavailable playlist fixture track.');
    }
    unavailable.unavailable = true;
    const plan = buildSyncPlan(
      snapshot({ favoriteIds: [], playlists: [] }),
      remote,
    );

    await expect(
      savePushJournal(root, {
        completedOperations: [],
        createdPlaylistIds: {},
        initialLocalContentFingerprint: 'local',
        phase: 'applying',
        plan,
        startedOperations: [],
        version: 2,
      }),
    ).resolves.toBeUndefined();
  });

  it('journals exact audio metadata in current playlist tracks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tidekeeper-journal-audio-'));
    roots.push(root);
    const remote = snapshot({
      favoriteIds: [],
      playlists: [playlist('quality', 'Top Quality', ['1'])],
    });
    const currentTrack = remote.playlists[0]?.tracks[0];
    if (!currentTrack) {
      throw new Error('Expected playlist fixture track.');
    }
    currentTrack.audio = {
      bitDepth: 24,
      format: 'FLAC_HIRES',
      mediaTags: ['HIRES_LOSSLESS'],
      sampleRateHz: 96_000,
    };
    const local = snapshot({
      favoriteIds: [],
      playlists: [playlist('quality', 'Top Quality', ['1', '2'])],
    });
    const plan = buildSyncPlan(local, remote);

    await expect(
      savePushJournal(root, {
        completedOperations: [],
        createdPlaylistIds: {},
        initialLocalContentFingerprint: 'local',
        phase: 'applying',
        plan,
        startedOperations: [],
        version: 2,
      }),
    ).resolves.toBeUndefined();
  });

  describe('sync locking', () => {
    it('rejects overlapping mutations for the same library', async () => {
      const root = await mkdtemp(join(tmpdir(), 'tidekeeper-lock-'));
      const entered = createDeferred();
      const release = createDeferred();
      const first = withSyncLock(root, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;

      await expect(
        withSyncLock(root, () => Promise.resolve()),
      ).rejects.toBeInstanceOf(ConflictError);
      release.resolve();
      await first;
      await rm(root, { force: true, recursive: true });
    });
  });

  it('resumes a mutation that succeeded remotely before its response failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tidekeeper-sync-'));
    roots.push(root);
    await initializeLibrary(root, 'US');
    const paths = createLibraryPaths(root);
    const favorites: FavoritesDocument = {
      kind: 'favorites',
      schemaVersion: 1,
      tracks: [track('1'), track('2')],
    };
    await writeYamlFileAtomic(
      paths.favorites,
      favorites,
      favoritesDocumentSchema,
    );
    await initializeGitRepository(root);

    const favoriteIds = new Set(['1']);
    const idempotencyKeys: string[] = [];
    let failFirstMutationResponse = true;
    const server = createServer((request, response) => {
      void handleTidalRequest(
        request.method ?? 'GET',
        new URL(request.url ?? '/', 'http://localhost'),
        request,
        response,
        favoriteIds,
        idempotencyKeys,
        () => {
          if (failFirstMutationResponse) {
            failFirstMutationResponse = false;
            return true;
          }
          return false;
        },
      );
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const client = createTidalClient({
      apiBaseUrl: `${baseUrl}/v2`,
      credentialsProvider,
    });

    await expect(
      pushLocal(client, root, { allowRemovals: true }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        'Adding TIDAL favorite tracks failed with HTTP 503: Response lost after commit',
      ),
    });
    expect(favoriteIds).toEqual(new Set(['1', '2']));
    expect(
      await pathExists(join(root, '.tidekeeper', 'journal', 'push.json')),
    ).toBe(true);

    const result = await pushLocal(client, root, { allowRemovals: true });

    expect(result.appliedOperations).toBe(1);
    expect(idempotencyKeys).toHaveLength(2);
    expect(idempotencyKeys[0]).toBe(idempotencyKeys[1]);
    expect(
      (await loadLibrary(root)).favorites.tracks.map((item) => item.id),
    ).toEqual(['1', '2']);
    expect(
      await pathExists(join(root, '.tidekeeper', 'journal', 'push.json')),
    ).toBe(false);
  });

  it('refuses to resume after an unrelated remote edit', async () => {
    const root = await createInitializedRoot(roots, ['1', '2']);
    const favoriteIds = new Set(['1']);
    const idempotencyKeys: string[] = [];
    let failFirstMutationResponse = true;
    const server = createServer((request, response) => {
      void handleTidalRequest(
        request.method ?? 'GET',
        new URL(request.url ?? '/', 'http://localhost'),
        request,
        response,
        favoriteIds,
        idempotencyKeys,
        () => {
          if (failFirstMutationResponse) {
            failFirstMutationResponse = false;
            return true;
          }
          return false;
        },
      );
    });
    servers.push(server);
    const client = createTidalClient({
      apiBaseUrl: `${await listen(server)}/v2`,
      credentialsProvider,
    });

    await expect(pushLocal(client, root)).rejects.toBeInstanceOf(
      PartialApplyError,
    );
    favoriteIds.add('3');

    await expect(pushLocal(client, root)).rejects.toBeInstanceOf(ConflictError);
    expect(idempotencyKeys).toHaveLength(1);
  });

  it('preserves terminal mutation conflicts instead of promising a transient resume', async () => {
    const root = await createInitializedRoot(roots, ['missing']);
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (
        request.method === 'POST' &&
        url.pathname === '/v2/userCollectionTracks/me/relationships/items'
      ) {
        respondJson(response, {
          data: [],
          links: { self: url.pathname },
          meta: {
            skipped: [{ id: 'missing', reason: 'NOT_FOUND', type: 'tracks' }],
          },
        });
        return;
      }
      handleSnapshotRead(url, response, []);
    });
    servers.push(server);
    const client = createTidalClient({
      apiBaseUrl: `${await listen(server)}/v2`,
      credentialsProvider,
    });

    await expect(pushLocal(client, root)).rejects.toBeInstanceOf(ConflictError);
    expect(
      await pathExists(join(root, '.tidekeeper', 'journal', 'push.json')),
    ).toBe(true);
  });

  it.each([
    ['before the local snapshot replacement', false],
    ['after the local snapshot replacement', true],
  ])('recovers finalization %s', async (_description, localWasReplaced) => {
    const root = await createInitializedRoot(roots, ['1', '2']);
    const local = await loadLibrary(root);
    const baseline = snapshot({
      favoriteIds: ['1'],
      playlists: [],
    });
    const finalRemote = snapshot({
      favoriteIds: ['1', '2'],
      playlists: [],
    });
    finalRemote.config = local.config;
    finalRemote.favorites.tracks = finalRemote.favorites.tracks.map(
      (item, index) => ({
        ...item,
        addedAt: `2026-01-0${index + 1}T00:00:00Z`,
      }),
    );
    const plan = buildSyncPlan(local, baseline);
    await savePushJournal(root, {
      completedOperations: [0],
      createdPlaylistIds: {},
      finalRemoteContentFingerprint: fingerprintSnapshotContent(finalRemote),
      finalRemoteFingerprint: fingerprintSnapshot(finalRemote),
      initialLocalContentFingerprint: fingerprintSnapshotContent(local),
      phase: 'finalizing',
      plan,
      startedOperations: [0],
      version: 2,
    });
    if (localWasReplaced) {
      await writeLibrarySnapshot(root, finalRemote);
    }

    let mutationRequests = 0;
    const server = createServer((request, response) => {
      if (request.method !== 'GET') {
        mutationRequests += 1;
      }
      handleSnapshotRead(
        new URL(request.url ?? '/', 'http://localhost'),
        response,
        ['1', '2'],
      );
    });
    servers.push(server);
    const client = createTidalClient({
      apiBaseUrl: `${await listen(server)}/v2`,
      credentialsProvider,
    });

    const result = await pushLocal(client, root);

    expect(result.appliedOperations).toBe(1);
    expect(mutationRequests).toBe(0);
    expect(
      await pathExists(join(root, '.tidekeeper', 'journal', 'push.json')),
    ).toBe(false);
  });

  it('preserves exact favorite audio metadata during zero-operation finalization', async () => {
    const root = await createInitializedRoot(roots, ['1']);
    const local = await loadLibrary(root);
    const favorite = local.favorites.tracks[0];
    if (!favorite) {
      throw new Error('Expected favorite fixture track.');
    }
    favorite.audio = {
      bitDepth: 24,
      format: 'FLAC_HIRES',
      mediaTags: ['HIRES_LOSSLESS'],
      sampleRateHz: 96_000,
    };
    await writeLibrarySnapshot(root, local);

    const server = createServer((request, response) => {
      handleSnapshotRead(
        new URL(request.url ?? '/', 'http://localhost'),
        response,
        ['1'],
      );
    });
    servers.push(server);
    const client = createTidalClient({
      apiBaseUrl: `${await listen(server)}/v2`,
      credentialsProvider,
    });

    const result = await pushLocal(client, root, { allowDirty: true });

    expect(result.appliedOperations).toBe(0);
    expect((await loadLibrary(root)).favorites.tracks[0]?.audio).toEqual({
      bitDepth: 24,
      format: 'FLAC_HIRES',
      mediaTags: ['HIRES_LOSSLESS'],
      sampleRateHz: 96_000,
    });
  });

  it('preserves local-only unavailable tracks when finalization resumes', async () => {
    const root = await createInitializedRoot(roots);
    const initialized = await loadLibrary(root);
    const local = snapshot({
      favoriteIds: [],
      playlists: [
        {
          ...playlist('remote-playlist', 'Local', ['available']),
          localId: '6d27c06c-18ce-46bb-a1ed-c0064bee7562',
          tracks: [
            { ...track('missing'), unavailable: true },
            {
              ...track('available'),
              audio: {
                bitDepth: 24,
                format: 'FLAC_HIRES',
                mediaTags: ['HIRES_LOSSLESS'],
                sampleRateHz: 96_000,
              },
              itemId: 'remote-playlist-item-0',
            },
          ],
        },
      ],
    });
    local.config = initialized.config;
    await writeLibrarySnapshot(root, local);
    await commitAll(root, 'Add local-only unavailable track');

    const finalRemote = snapshot({
      favoriteIds: [],
      playlists: [playlist('remote-playlist', 'Local', ['available'])],
    });
    finalRemote.config = local.config;
    const plan = buildSyncPlan(local, finalRemote);
    expect(plan.operations).toEqual([]);
    await savePushJournal(root, {
      completedOperations: [],
      createdPlaylistIds: {},
      finalRemoteContentFingerprint: fingerprintSnapshotContent(local),
      finalRemoteFingerprint: fingerprintSnapshot(finalRemote),
      initialLocalContentFingerprint: fingerprintSnapshotContent(local),
      phase: 'finalizing',
      plan,
      startedOperations: [],
      version: 2,
    });

    let mutationRequests = 0;
    const server = createServer((request, response) => {
      if (request.method !== 'GET') {
        mutationRequests += 1;
      }
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/v2/playlists') {
        respondJson(response, {
          data: [
            {
              attributes: { description: '', name: 'Local' },
              id: 'remote-playlist',
              type: 'playlists',
            },
          ],
          links: { self: '/playlists' },
        });
        return;
      }
      if (
        url.pathname === '/v2/playlists/remote-playlist/relationships/items'
      ) {
        respondJson(response, {
          data: [
            {
              id: 'available',
              meta: { itemId: 'remote-playlist-item-0' },
              type: 'tracks',
            },
          ],
          links: { self: url.pathname },
        });
        return;
      }
      handleSnapshotRead(url, response, []);
    });
    servers.push(server);
    const client = createTidalClient({
      apiBaseUrl: `${await listen(server)}/v2`,
      credentialsProvider,
    });

    const result = await pushLocal(client, root);

    expect(result.appliedOperations).toBe(0);
    expect(mutationRequests).toBe(0);
    const synchronized = await loadLibrary(root);
    expect(synchronized.playlists[0]).toMatchObject({
      id: 'remote-playlist',
      localId: '6d27c06c-18ce-46bb-a1ed-c0064bee7562',
      tracks: [
        { id: 'missing', unavailable: true },
        {
          audio: {
            bitDepth: 24,
            format: 'FLAC_HIRES',
            mediaTags: ['HIRES_LOSSLESS'],
            sampleRateHz: 96_000,
          },
          id: 'available',
          itemId: 'remote-playlist-item-0',
        },
      ],
    });
    expect(
      await pathExists(join(root, '.tidekeeper', 'journal', 'push.json')),
    ).toBe(false);
  });

  it('refreshes local state and clears finalization after later remote drift', async () => {
    const root = await createInitializedRoot(roots, ['1', '2']);
    const local = await loadLibrary(root);
    const baseline = snapshot({ favoriteIds: ['1'], playlists: [] });
    const finalRemote = snapshot({ favoriteIds: ['1', '2'], playlists: [] });
    finalRemote.config = local.config;
    const plan = buildSyncPlan(local, baseline);
    await savePushJournal(root, {
      completedOperations: [0],
      createdPlaylistIds: {},
      finalRemoteContentFingerprint: fingerprintSnapshotContent(finalRemote),
      finalRemoteFingerprint: fingerprintSnapshot(finalRemote),
      initialLocalContentFingerprint: fingerprintSnapshotContent(local),
      phase: 'finalizing',
      plan,
      startedOperations: [0],
      version: 2,
    });

    const server = createServer((request, response) => {
      handleSnapshotRead(
        new URL(request.url ?? '/', 'http://localhost'),
        response,
        ['1', '2', '3'],
      );
    });
    servers.push(server);
    const client = createTidalClient({
      apiBaseUrl: `${await listen(server)}/v2`,
      credentialsProvider,
    });

    await expect(pushLocal(client, root)).rejects.toBeInstanceOf(ConflictError);
    expect(
      (await loadLibrary(root)).favorites.tracks.map((item) => item.id),
    ).toEqual(['1', '2', '3']);
    expect(
      await pathExists(join(root, '.tidekeeper', 'journal', 'push.json')),
    ).toBe(false);
  });

  it('requires explicit approval before applying removals', async () => {
    const root = await createInitializedRoot(roots);
    let mutationRequests = 0;
    const server = createServer((request, response) => {
      const method = request.method ?? 'GET';
      if (method !== 'GET') {
        mutationRequests += 1;
      }
      handleSnapshotRead(
        new URL(request.url ?? '/', 'http://localhost'),
        response,
        ['remote-only'],
      );
    });
    servers.push(server);
    const client = createTidalClient({
      apiBaseUrl: `${await listen(server)}/v2`,
      credentialsProvider,
    });

    await expect(pushLocal(client, root)).rejects.toBeInstanceOf(ConflictError);
    expect(mutationRequests).toBe(0);
    expect(
      await pathExists(join(root, '.tidekeeper', 'journal', 'push.json')),
    ).toBe(false);
  });

  it('aborts before mutation when the remote snapshot changes during planning', async () => {
    const root = await createInitializedRoot(roots, ['1', '2']);
    let favoriteReads = 0;
    let mutationRequests = 0;
    const server = createServer((request, response) => {
      const method = request.method ?? 'GET';
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (method !== 'GET') {
        mutationRequests += 1;
      }
      if (
        method === 'GET' &&
        url.pathname === '/v2/userCollectionTracks/me/relationships/items'
      ) {
        favoriteReads += 1;
        respondFavoriteIdentifiers(
          response,
          favoriteReads === 1 ? ['1'] : ['1', '3'],
          url.pathname,
        );
        return;
      }
      handleSnapshotRead(url, response, []);
    });
    servers.push(server);
    const client = createTidalClient({
      apiBaseUrl: `${await listen(server)}/v2`,
      credentialsProvider,
    });

    await expect(pushLocal(client, root)).rejects.toThrow(
      /changed while the push was being planned/,
    );
    expect(favoriteReads).toBe(2);
    expect(mutationRequests).toBe(0);
  });

  it('protects a configured library directory from dirty pushes', async () => {
    const root = await createInitializedRoot(roots);
    const defaultPaths = createLibraryPaths(root);
    await rename(defaultPaths.library, join(root, 'catalog'));
    await writeYamlFileAtomic(
      defaultPaths.config,
      {
        libraryDirectory: 'catalog',
        schemaVersion: 1,
      },
      tidekeeperConfigSchema,
    );
    await commitAll(root, 'Configure custom library');
    await appendFile(join(root, 'catalog', 'favorites.yaml'), '# dirty\n');

    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      handleSnapshotRead(
        new URL(request.url ?? '/', 'http://localhost'),
        response,
        [],
      );
    });
    servers.push(server);
    const client = createTidalClient({
      apiBaseUrl: `${await listen(server)}/v2`,
      credentialsProvider,
    });

    await expect(pushLocal(client, root)).rejects.toThrow(
      /managed files have uncommitted changes/,
    );
    expect(requests).toBe(0);
  });
});

function snapshot({
  favoriteIds,
  playlists,
}: {
  favoriteIds: string[];
  playlists: PlaylistDocument[];
}): LibrarySnapshot {
  return {
    config: { libraryDirectory: 'library', schemaVersion: 1 },
    favorites: {
      kind: 'favorites',
      schemaVersion: 1,
      tracks: favoriteIds.map(track),
    },
    playlists,
  };
}

function playlist(
  id: string,
  title: string,
  trackIds: string[],
): PlaylistDocument {
  return {
    description: '',
    id,
    kind: 'playlist',
    schemaVersion: 1,
    title,
    tracks: trackIds.map((trackId, index) => ({
      ...track(trackId),
      itemId: `${id}-item-${index}`,
    })),
  };
}

function track(id: string) {
  return {
    artists: [`Artist ${id}`],
    id,
    title: `Track ${id}`,
  };
}

async function handleTidalRequest(
  method: string,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  favoriteIds: Set<string>,
  idempotencyKeys: string[],
  shouldFailMutationResponse: () => boolean,
): Promise<void> {
  if (method === 'GET' && url.pathname === '/v2/playlists') {
    respondJson(response, {
      data: [],
      links: { self: '/playlists' },
    });
    return;
  }

  if (
    method === 'GET' &&
    url.pathname === '/v2/userCollectionTracks/me/relationships/items'
  ) {
    respondJson(response, {
      data: [...favoriteIds].sort().map((id) => ({
        id,
        meta: { addedAt: '2026-01-01T00:00:00Z' },
        type: 'tracks',
      })),
      links: { self: url.pathname },
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/v2/tracks') {
    respondJson(response, tracksPage(trackIdsFrom(url)));
    return;
  }

  if (
    method === 'POST' &&
    url.pathname === '/v2/userCollectionTracks/me/relationships/items'
  ) {
    const body = JSON.parse(await readRequest(request)) as {
      data: { id: string }[];
    };
    for (const item of body.data) {
      favoriteIds.add(item.id);
    }
    idempotencyKeys.push(requestHeader(request, 'idempotency-key'));
    if (shouldFailMutationResponse()) {
      respondJson(
        response,
        {
          errors: [
            {
              code: 'SERVICE_UNAVAILABLE',
              detail: 'Response lost after commit',
              status: '503',
            },
          ],
        },
        503,
      );
      return;
    }
    respondJson(response, {
      data: body.data.map((item) => ({ ...item, type: 'tracks' })),
      links: { self: url.pathname },
      meta: { skipped: [] },
    });
    return;
  }

  response.writeHead(404).end();
}

function tracksPage(ids: string[]) {
  return {
    data: ids.map((id) => ({
      attributes: {
        duration: 'PT3M2S',
        explicit: false,
        externalLinks: [],
        title: `Track ${id}`,
      },
      id,
      relationships: {
        albums: {
          data: [{ id: `album-${id}`, type: 'albums' }],
          links: { self: `/tracks/${id}/relationships/albums` },
        },
        artists: {
          data: [{ id: `artist-${id}`, type: 'artists' }],
          links: { self: `/tracks/${id}/relationships/artists` },
        },
      },
      type: 'tracks',
    })),
    included: ids.flatMap((id) => [
      {
        attributes: { name: `Artist ${id}` },
        id: `artist-${id}`,
        type: 'artists',
      },
      {
        attributes: { title: `Album ${id}` },
        id: `album-${id}`,
        type: 'albums',
      },
    ]),
    links: { self: '/tracks' },
  };
}

function trackIdsFrom(url: URL): string[] {
  return url.searchParams
    .getAll('filter[id]')
    .flatMap((value) => value.split(','));
}

async function initializeGitRepository(root: string): Promise<void> {
  await execFileAsync('git', ['-C', root, 'init', '--quiet']);
  await execFileAsync('git', [
    '-C',
    root,
    'config',
    'user.email',
    'test@example.com',
  ]);
  await execFileAsync('git', [
    '-C',
    root,
    'config',
    'user.name',
    'Tidekeeper Test',
  ]);
  await execFileAsync('git', ['-C', root, 'add', '.']);
  await commitAll(root, 'Initial');
}

async function commitAll(root: string, message: string): Promise<void> {
  await execFileAsync('git', ['-C', root, 'add', '.']);
  await execFileAsync('git', ['-C', root, 'commit', '--quiet', '-m', message]);
}

async function createInitializedRoot(
  roots: string[],
  favoriteIds: string[] = [],
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tidekeeper-sync-'));
  roots.push(root);
  await initializeLibrary(root, 'US');
  if (favoriteIds.length > 0) {
    const paths = createLibraryPaths(root);
    await writeYamlFileAtomic(
      paths.favorites,
      {
        kind: 'favorites',
        schemaVersion: 1,
        tracks: favoriteIds.map(track),
      },
      favoritesDocumentSchema,
    );
  }
  await initializeGitRepository(root);
  return root;
}

function handleSnapshotRead(
  url: URL,
  response: ServerResponse,
  favoriteIds: string[],
): void {
  if (url.pathname === '/v2/playlists') {
    respondJson(response, {
      data: [],
      links: { self: '/playlists' },
    });
    return;
  }
  if (url.pathname === '/v2/userCollectionTracks/me/relationships/items') {
    respondFavoriteIdentifiers(response, favoriteIds, url.pathname);
    return;
  }
  if (url.pathname === '/v2/tracks') {
    respondJson(response, tracksPage(trackIdsFrom(url)));
    return;
  }
  response.writeHead(404).end();
}

function respondFavoriteIdentifiers(
  response: ServerResponse,
  favoriteIds: string[],
  path: string,
): void {
  respondJson(response, {
    data: favoriteIds.map((id) => ({
      id,
      meta: { addedAt: '2026-01-01T00:00:00Z' },
      type: 'tracks',
    })),
    links: { self: path },
  });
}

function requestHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

async function readRequest(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function respondJson(
  response: ServerResponse,
  value: unknown,
  status = 200,
): void {
  response.writeHead(status, {
    'Content-Type': 'application/vnd.api+json',
  });
  response.end(JSON.stringify(value));
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = (): void => {
    throw new Error('Deferred promise was not initialized.');
  };
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
