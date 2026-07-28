import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import type { CredentialsProvider } from '@tidal-music/common';
import { afterEach, describe, expect, it } from 'vitest';

import { loadTidalClientConfig } from '../src/auth/config.js';
import {
  AuthenticationError,
  ConflictError,
  NetworkError,
} from '../src/errors.js';
import {
  createTidalClient,
  executeTidalRequest,
  throwForTidalError,
} from '../src/tidal/client.js';
import {
  addFavoriteTracks,
  getFavoriteTracks,
  removeFavoriteTracks,
} from '../src/tidal/favorites.js';
import { parseIsoDuration } from '../src/tidal/normalize.js';
import {
  createPlaylist,
  deletePlaylist,
  getOwnedPlaylists,
  replacePlaylistTracks,
  updatePlaylist,
} from '../src/tidal/playlists.js';
import { searchTracks } from '../src/tidal/search.js';
import { getRemoteSnapshot } from '../src/tidal/snapshot.js';

const credentialsProvider: CredentialsProvider = {
  bus: () => undefined,
  getCredentials: () =>
    Promise.resolve({
      clientId: 'test-client',
      requestedScopes: [],
      token: 'test-token',
    }),
};

describe('TIDAL adapter', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  });

  it('exhausts search cursors and bulk-hydrates tracks in result order', async () => {
    const requests: URL[] = [];
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      requests.push(url);

      if (url.pathname.endsWith('/searchResults/miles/relationships/tracks')) {
        const cursor = url.searchParams.get('page[cursor]');
        respondJson(
          response,
          cursor
            ? relationshipPage(['3'])
            : relationshipPage(['2', '1'], 'next-page'),
        );
        return;
      }

      if (url.pathname.endsWith('/tracks')) {
        respondJson(response, tracksPage(trackIdsFrom(url)));
        return;
      }

      response.writeHead(404).end();
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const client = createTidalClient({
      apiBaseUrl: `${baseUrl}/v2`,
      credentialsProvider,
    });

    const tracks = await searchTracks(client, 'miles', {
      countryCode: 'US',
      explicitFilter: 'EXCLUDE',
    });

    expect(tracks.map((track) => track.id)).toEqual(['2', '1', '3']);
    expect(tracks[0]).toEqual({
      album: 'Album 2',
      artists: ['Artist 2'],
      durationSeconds: 182,
      explicit: false,
      id: '2',
      tidalUrl: 'https://tidal.com/browse/track/2',
      title: 'Track 2',
    });
    expect(
      requests.filter((request) =>
        request.pathname.endsWith('/searchResults/miles/relationships/tracks'),
      ),
    ).toHaveLength(2);
    expect(
      requests.filter((request) => request.pathname === '/v2/tracks'),
    ).toHaveLength(2);
    expect(requests[0]?.searchParams.get('countryCode')).toBe('US');
    expect(requests[0]?.searchParams.get('explicitFilter')).toBe('EXCLUDE');
  });

  it('stops at an explicit limit without fetching another cursor page', async () => {
    let searchRequests = 0;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname.includes('/searchResults/')) {
        searchRequests += 1;
        respondJson(response, relationshipPage(['1', '2'], 'next-page'));
        return;
      }
      if (url.pathname.endsWith('/tracks')) {
        respondJson(response, tracksPage(trackIdsFrom(url)));
        return;
      }
      response.writeHead(404).end();
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const client = createTidalClient({
      apiBaseUrl: `${baseUrl}/v2`,
      credentialsProvider,
    });

    const tracks = await searchTracks(client, 'limited', { limit: 1 });

    expect(tracks.map((track) => track.id)).toEqual(['1']);
    expect(searchRequests).toBe(1);
  });

  it('maps TIDAL service errors to stable network failures', async () => {
    const server = createServer((_request, response) => {
      respondJson(
        response,
        {
          errors: [
            {
              code: 'SERVICE_UNAVAILABLE',
              detail: 'Try again later',
              status: '503',
            },
          ],
        },
        503,
      );
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const client = createTidalClient({
      apiBaseUrl: `${baseUrl}/v2`,
      credentialsProvider,
    });

    await expect(searchTracks(client, 'failure')).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it('loads paginated favorites and playlists without losing repeated ordered tracks', async () => {
    const requests: { method: string; url: URL }[] = [];
    const server = createServer((request, response) => {
      const method = request.method ?? 'GET';
      const url = new URL(request.url ?? '/', 'http://localhost');
      requests.push({ method, url });

      if (url.pathname === '/v2/playlists') {
        const cursor = url.searchParams.get('page[cursor]');
        respondJson(
          response,
          cursor
            ? playlistsPage([playlistResource('a', 'Alpha')])
            : playlistsPage([playlistResource('b', 'Beta')], 'next-playlist'),
        );
        return;
      }

      if (url.pathname === '/v2/playlists/a/relationships/items') {
        respondJson(response, relationshipPage([]));
        return;
      }

      if (url.pathname === '/v2/playlists/b/relationships/items') {
        const cursor = url.searchParams.get('page[cursor]');
        respondJson(
          response,
          cursor
            ? relationshipPage(['1'], undefined, ['b-item-3'])
            : relationshipPage(['2', '2'], 'next-item', [
                'b-item-1',
                'b-item-2',
              ]),
        );
        return;
      }

      if (url.pathname === '/v2/userCollectionTracks/me/relationships/items') {
        const cursor = url.searchParams.get('page[cursor]');
        respondJson(
          response,
          cursor
            ? relationshipPage(['3'], undefined, undefined, [
                '2026-01-03T00:00:00Z',
              ])
            : relationshipPage(['1'], 'next-favorite', undefined, [
                '2026-01-01T00:00:00Z',
              ]),
        );
        return;
      }

      if (url.pathname === '/v2/tracks') {
        respondJson(response, tracksPage(trackIdsFrom(url)));
        return;
      }

      response.writeHead(404).end();
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const client = createTidalClient({
      apiBaseUrl: `${baseUrl}/v2`,
      credentialsProvider,
    });

    const [favorites, playlists] = await Promise.all([
      getFavoriteTracks(client, 'US'),
      getOwnedPlaylists(client, 'US'),
    ]);

    expect(favorites.tracks.map((track) => [track.id, track.addedAt])).toEqual([
      ['1', '2026-01-01T00:00:00Z'],
      ['3', '2026-01-03T00:00:00Z'],
    ]);
    expect(playlists.map((playlist) => playlist.id)).toEqual(['a', 'b']);
    expect(
      playlists[1]?.tracks.map((track) => [track.id, track.itemId]),
    ).toEqual([
      ['2', 'b-item-1'],
      ['2', 'b-item-2'],
      ['1', 'b-item-3'],
    ]);
    expect(
      requests.filter(({ url }) => url.pathname === '/v2/playlists'),
    ).toHaveLength(2);
    expect(
      requests.filter(
        ({ url }) =>
          url.pathname === '/v2/userCollectionTracks/me/relationships/items',
      ),
    ).toHaveLength(2);
    expect(
      requests
        .find(({ url }) => url.pathname === '/v2/playlists')
        ?.url.searchParams.getAll('filter[owners.id]'),
    ).toEqual(['me']);
  });

  it('preserves playlist items whose catalog metadata is unavailable', async () => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/v2/playlists') {
        respondJson(
          response,
          playlistsPage([playlistResource('playlist', 'Unavailable tracks')]),
        );
        return;
      }
      if (url.pathname === '/v2/playlists/playlist/relationships/items') {
        respondJson(
          response,
          relationshipPage(['available', 'unavailable'], undefined, [
            'available-item',
            'unavailable-item',
          ]),
        );
        return;
      }
      if (url.pathname === '/v2/tracks') {
        respondJson(
          response,
          tracksPage(
            trackIdsFrom(url).filter((trackId) => trackId !== 'unavailable'),
          ),
        );
        return;
      }
      response.writeHead(404).end();
    });
    servers.push(server);
    const client = createTidalClient({
      apiBaseUrl: `${await listen(server)}/v2`,
      credentialsProvider,
    });

    const [playlist] = await getOwnedPlaylists(client, 'US');

    expect(playlist?.tracks).toEqual([
      expect.objectContaining({ id: 'available', itemId: 'available-item' }),
      {
        artists: ['TIDAL metadata unavailable'],
        id: 'unavailable',
        itemId: 'unavailable-item',
        title: '[Unavailable track]',
        unavailable: true,
      },
    ]);
  });

  it('loads playlist relationship pages serially to avoid rate-limit bursts', async () => {
    let activeRelationshipRequests = 0;
    let maximumConcurrentRelationshipRequests = 0;
    const server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (url.pathname === '/v2/playlists') {
          respondJson(
            response,
            playlistsPage([
              playlistResource('a', 'Alpha'),
              playlistResource('b', 'Beta'),
            ]),
          );
          return;
        }
        if (url.pathname.endsWith('/relationships/items')) {
          activeRelationshipRequests += 1;
          maximumConcurrentRelationshipRequests = Math.max(
            maximumConcurrentRelationshipRequests,
            activeRelationshipRequests,
          );
          await new Promise((resolve) => setTimeout(resolve, 10));
          activeRelationshipRequests -= 1;
          respondJson(response, relationshipPage([]));
          return;
        }
        if (url.pathname === '/v2/tracks') {
          respondJson(response, tracksPage(trackIdsFrom(url)));
          return;
        }
        response.writeHead(404).end();
      })();
    });
    servers.push(server);
    const client = createTidalClient({
      apiBaseUrl: `${await listen(server)}/v2`,
      credentialsProvider,
    });

    await getOwnedPlaylists(client, 'US');

    expect(maximumConcurrentRelationshipRequests).toBe(1);
  });

  it('serializes a remote snapshot to avoid contending with collection reads', async () => {
    let activeRequests = 0;
    let maximumConcurrentRequests = 0;
    const server = createServer((request, response) => {
      void (async () => {
        const url = new URL(request.url ?? '/', 'http://localhost');
        activeRequests += 1;
        maximumConcurrentRequests = Math.max(
          maximumConcurrentRequests,
          activeRequests,
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeRequests -= 1;

        if (url.pathname === '/v2/playlists') {
          respondJson(
            response,
            playlistsPage([playlistResource('playlist', 'Playlist')]),
          );
          return;
        }
        if (
          url.pathname === '/v2/userCollectionTracks/me/relationships/items'
        ) {
          respondJson(response, relationshipPage(['favorite']));
          return;
        }
        if (url.pathname === '/v2/playlists/playlist/relationships/items') {
          respondJson(response, relationshipPage(['playlist-track']));
          return;
        }
        if (url.pathname === '/v2/tracks') {
          respondJson(response, tracksPage(trackIdsFrom(url)));
          return;
        }
        response.writeHead(404).end();
      })();
    });
    servers.push(server);
    const client = createTidalClient({
      apiBaseUrl: `${await listen(server)}/v2`,
      credentialsProvider,
    });

    await getRemoteSnapshot(client, {
      countryCode: 'US',
      libraryDirectory: 'library',
      schemaVersion: 1,
    });

    expect(maximumConcurrentRequests).toBe(1);
  });

  it('sends deterministic idempotency keys and item identities for mutations', async () => {
    const requests: {
      body: unknown;
      idempotencyKey: string;
      method: string;
      url: URL;
    }[] = [];
    const server = createServer((request, response) => {
      void recordMutation(request, response, requests);
    });
    servers.push(server);
    const baseUrl = await listen(server);
    const client = createTidalClient({
      apiBaseUrl: `${baseUrl}/v2`,
      credentialsProvider,
    });

    const playlistId = await createPlaylist(
      client,
      { description: 'Created', title: 'Create me' },
      'create-key',
      'US',
    );
    await updatePlaylist(
      client,
      playlistId,
      { description: 'Updated', title: 'Rename me' },
      'update-key',
      'US',
    );
    await replacePlaylistTracks(
      client,
      playlistId,
      [
        {
          artists: ['Artist 1'],
          id: '1',
          itemId: 'item-1',
          title: 'Track 1',
        },
        {
          artists: ['Artist 1'],
          id: '1',
          itemId: 'item-2',
          title: 'Track 1',
        },
      ],
      ['2', '1'],
      'replace-key',
      'US',
    );
    await deletePlaylist(client, playlistId, 'delete-key');
    await addFavoriteTracks(client, ['1', '2'], 'favorites-add-key');
    await removeFavoriteTracks(client, ['3'], 'favorites-remove-key');

    expect(playlistId).toBe('created-playlist');
    expect(
      requests.map(({ idempotencyKey, method, url }) => [
        method,
        url.pathname,
        idempotencyKey,
      ]),
    ).toEqual([
      ['POST', '/v2/playlists', 'create-key'],
      ['PATCH', '/v2/playlists/created-playlist', 'update-key'],
      [
        'DELETE',
        '/v2/playlists/created-playlist/relationships/items',
        'replace-key-remove-0',
      ],
      [
        'POST',
        '/v2/playlists/created-playlist/relationships/items',
        'replace-key-add-0',
      ],
      ['DELETE', '/v2/playlists/created-playlist', 'delete-key'],
      [
        'POST',
        '/v2/userCollectionTracks/me/relationships/items',
        'favorites-add-key-0',
      ],
      [
        'DELETE',
        '/v2/userCollectionTracks/me/relationships/items',
        'favorites-remove-key-0',
      ],
    ]);
    expect(requests[2]?.body).toEqual({
      data: [
        { id: '1', meta: { itemId: 'item-1' }, type: 'tracks' },
        { id: '1', meta: { itemId: 'item-2' }, type: 'tracks' },
      ],
    });
    expect(requests[3]?.body).toEqual({
      data: [
        { id: '2', type: 'tracks' },
        { id: '1', type: 'tracks' },
      ],
    });
  });

  it('chunks large mutations into deterministic groups of at most 50 items', async () => {
    const requests: {
      body: unknown;
      idempotencyKey: string;
      method: string;
      url: URL;
    }[] = [];
    const server = createServer((request, response) => {
      void recordMutation(request, response, requests);
    });
    servers.push(server);
    const client = createTidalClient({
      apiBaseUrl: `${await listen(server)}/v2`,
      credentialsProvider,
    });
    const ids = Array.from({ length: 120 }, (_, index) => String(index + 1));

    await addFavoriteTracks(client, ids, 'favorite-add');
    await removeFavoriteTracks(client, ids, 'favorite-remove');
    await replacePlaylistTracks(
      client,
      'playlist',
      ids.map((id) => ({
        artists: [`Artist ${id}`],
        id,
        itemId: `item-${id}`,
        title: `Track ${id}`,
      })),
      ids,
      'playlist-replace',
      'US',
    );

    expect(
      requests.map(({ body, idempotencyKey }) => [
        idempotencyKey,
        (body as { data: unknown[] }).data.length,
      ]),
    ).toEqual([
      ['favorite-add-0', 50],
      ['favorite-add-1', 50],
      ['favorite-add-2', 20],
      ['favorite-remove-0', 50],
      ['favorite-remove-1', 50],
      ['favorite-remove-2', 20],
      ['playlist-replace-remove-0', 50],
      ['playlist-replace-remove-1', 50],
      ['playlist-replace-remove-2', 20],
      ['playlist-replace-add-0', 50],
      ['playlist-replace-add-1', 50],
      ['playlist-replace-add-2', 20],
    ]);
  });

  it('rejects favorite additions skipped because a track was not found', async () => {
    const server = createServer((_request, response) => {
      respondJson(response, {
        data: [],
        links: { self: '/favorites' },
        meta: {
          skipped: [{ id: 'missing', reason: 'NOT_FOUND', type: 'tracks' }],
        },
      });
    });
    servers.push(server);
    const client = createTidalClient({
      apiBaseUrl: `${await listen(server)}/v2`,
      credentialsProvider,
    });

    await expect(
      addFavoriteTracks(client, ['missing'], 'missing-key'),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('classifies nested JSON:API authentication and conflict errors', () => {
    expect(() =>
      throwForTidalError(
        { errors: [{ detail: 'Expired', status: '401' }] },
        'Authentication',
      ),
    ).toThrow(AuthenticationError);
    expect(() =>
      throwForTidalError(
        { errors: [{ detail: 'Changed', status: '409' }] },
        'Mutation',
      ),
    ).toThrow(ConflictError);
  });

  it('classifies TIDAL authorization codes when the response omits HTTP status', () => {
    expect(() =>
      throwForTidalError(
        {
          errors: [
            {
              code: 'UNAUTHORIZED',
              detail: 'Mutation not allowed, missing scopes',
            },
          ],
        },
        'Creating TIDAL playlist',
      ),
    ).toThrow(
      'Creating TIDAL playlist failed: Mutation not allowed, missing scopes',
    );
    expect(() =>
      throwForTidalError(
        {
          errors: [
            {
              code: 'UNAUTHORIZED',
              detail: 'Mutation not allowed, missing scopes',
            },
          ],
        },
        'Creating TIDAL playlist',
      ),
    ).toThrow(AuthenticationError);
  });

  it('classifies an in-progress idempotent mutation as resumable', () => {
    expect(() =>
      throwForTidalError(
        {
          errors: [
            {
              code: 'IDEMPOTENT_REQUEST_IN_PROGRESS',
              detail: 'Original request is still processing',
              status: '409',
            },
          ],
        },
        'Mutation',
      ),
    ).toThrow(NetworkError);
  });

  it('maps rejected transport calls to stable network failures', async () => {
    await expect(
      executeTidalRequest('Transport test', () =>
        Promise.reject(new Error('socket closed')),
      ),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('retries a rate-limited response using Retry-After', async () => {
    let requests = 0;

    const result = await executeTidalRequest('Rate-limited request', () => {
      requests += 1;
      return Promise.resolve({
        response:
          requests === 1
            ? new Response(null, {
                headers: { 'Retry-After': '0' },
                status: 429,
              })
            : new Response(null, { status: 204 }),
      });
    });

    expect(result.response.status).toBe(204);
    expect(requests).toBe(2);
  });
});

describe('TIDAL configuration and normalization', () => {
  it('requests the enabled TIDAL authorization-code scopes by default', () => {
    expect(loadTidalClientConfig({ TIDAL_CLIENT_ID: 'client-id' })).toEqual({
      clientId: 'client-id',
      scopes: [
        'collection.read',
        'collection.write',
        'entitlements.read',
        'playback',
        'playlists.read',
        'playlists.write',
        'recommendations.read',
        'search.read',
        'search.write',
        'user.read',
      ],
    });
  });

  it('parses the ISO duration returned by TIDAL', () => {
    expect(parseIsoDuration('P1DT2H3M4.5S')).toBe(93_784.5);
  });

  it('rejects malformed remote durations', () => {
    expect(() => parseIsoDuration('three minutes')).toThrow(
      /invalid ISO 8601 duration/,
    );
  });
});

function relationshipPage(
  ids: string[],
  nextCursor?: string,
  itemIds?: string[],
  addedAt?: string[],
) {
  return {
    data: ids.map((id, index) => ({
      id,
      ...(itemIds?.[index] || addedAt?.[index]
        ? {
            meta: {
              ...(addedAt?.[index] ? { addedAt: addedAt[index] } : {}),
              ...(itemIds?.[index] ? { itemId: itemIds[index] } : {}),
            },
          }
        : {}),
      type: 'tracks',
    })),
    links: {
      ...(nextCursor ? { meta: { nextCursor } } : {}),
      self: '/searchResults/query/relationships/tracks',
    },
  };
}

function playlistResource(id: string, name: string) {
  return {
    attributes: { description: `${name} description`, name },
    id,
    type: 'playlists',
  };
}

function playlistsPage(data: unknown[], nextCursor?: string) {
  return {
    data,
    links: {
      ...(nextCursor ? { meta: { nextCursor } } : {}),
      self: '/playlists',
    },
  };
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

async function recordMutation(
  request: IncomingMessage,
  response: ServerResponse,
  requests: {
    body: unknown;
    idempotencyKey: string;
    method: string;
    url: URL;
  }[],
): Promise<void> {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://localhost');
  const bodyText = await readRequest(request);
  requests.push({
    body: bodyText ? (JSON.parse(bodyText) as unknown) : undefined,
    idempotencyKey: requestHeader(request, 'idempotency-key'),
    method,
    url,
  });

  if (method === 'POST' && url.pathname === '/v2/playlists') {
    respondJson(
      response,
      { data: { id: 'created-playlist', type: 'playlists' } },
      201,
    );
    return;
  }
  if (method === 'PATCH') {
    respondJson(response, {
      data: { id: 'created-playlist', type: 'playlists' },
    });
    return;
  }
  if (
    method === 'POST' &&
    url.pathname === '/v2/userCollectionTracks/me/relationships/items'
  ) {
    respondJson(response, {
      data: [],
      links: { self: url.pathname },
      meta: { skipped: [] },
    });
    return;
  }
  if (method === 'POST') {
    respondJson(response, {
      data: [],
      links: { self: url.pathname },
      meta: { nextCursor: '' },
    });
    return;
  }
  response.writeHead(204).end();
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
