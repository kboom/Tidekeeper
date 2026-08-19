import { createServer, type Server, type ServerResponse } from 'node:http';

import type { CredentialsProvider } from '@tidal-music/common';
import { afterEach, describe, expect, it } from 'vitest';

import { createTidalClient } from '../src/tidal/client.js';
import { findRelatedTracks } from '../src/tidal/related.js';

const credentialsProvider: CredentialsProvider = {
  bus: () => undefined,
  getCredentials: () =>
    Promise.resolve({
      clientId: 'test-client',
      requestedScopes: [],
      token: 'test-token',
    }),
};

describe('related tracks', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  });

  it.each([
    {
      by: 'album' as const,
      path: '/v2/albums/album-seed/relationships/items',
    },
    {
      by: 'artist' as const,
      path: '/v2/artists/artist-seed/relationships/tracks',
    },
  ])('finds new tracks by $by and excludes seeds', async ({ by, path }) => {
    let relatedRequest: URL | undefined;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/v2/tracks') {
        const ids = url.searchParams.getAll('filter[id]');
        respondJson(response, tracksPage(ids));
        return;
      }
      if (url.pathname === path) {
        relatedRequest = url;
        respondJson(response, {
          data: [
            { id: 'seed', type: 'tracks' },
            { id: 'related', type: 'tracks' },
          ],
          links: { self: path },
        });
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

    const result = await findRelatedTracks(
      client,
      [{ artists: ['Seed Artist'], id: 'seed', title: 'Seed' }],
      { by, limitPerSource: 20 },
    );

    expect(result).toEqual([
      expect.objectContaining({
        artists: ['Artist related'],
        id: 'related',
        title: 'Track related',
      }),
    ]);
    if (by === 'artist') {
      expect(relatedRequest?.searchParams.get('collapseBy')).toBe(
        'FINGERPRINT',
      );
    }
  });
});

function tracksPage(ids: string[]) {
  return {
    data: ids.map((id) => ({
      attributes: {
        duration: 'PT3M2S',
        explicit: false,
        externalLinks: [],
        mediaTags: ['HIRES_LOSSLESS'],
        title: `Track ${id}`,
      },
      id,
      relationships: {
        albums: {
          data: [{ id: 'album-seed', type: 'albums' }],
          links: { self: `/tracks/${id}/relationships/albums` },
        },
        artists: {
          data: [{ id: 'artist-seed', type: 'artists' }],
          links: { self: `/tracks/${id}/relationships/artists` },
        },
      },
      type: 'tracks',
    })),
    included: ids.flatMap((id) => [
      {
        attributes: { name: `Artist ${id}` },
        id: 'artist-seed',
        type: 'artists',
      },
      {
        attributes: { title: `Album ${id}` },
        id: 'album-seed',
        type: 'albums',
      },
    ]),
    links: { self: '/tracks' },
  };
}

function respondJson(response: ServerResponse, value: unknown): void {
  response.writeHead(200, {
    'Content-Type': 'application/vnd.api+json',
  });
  response.end(JSON.stringify(value));
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP server address.');
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
