import { createServer, type Server, type ServerResponse } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import type { CredentialsProvider } from '@tidal-music/common';
import { AuthenticationError, NetworkError } from '../src/errors.js';
import { createTidalClient } from '../src/tidal/client.js';
import {
  inspectTrackQuality,
  loadPlaybackAudioQuality,
  parseDashAudioRepresentations,
} from '../src/tidal/quality.js';

const credentialsProvider: CredentialsProvider = {
  bus: () => undefined,
  getCredentials: () =>
    Promise.resolve({
      clientId: 'test-client',
      requestedScopes: [],
      token: 'test-token',
    }),
};

describe('track audio quality', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  });

  it('loads exact bit depth and sample rate from a DASH manifest', async () => {
    const xml = `
      <MPD>
        <Representation id="audio,0,24" codecs="flac" audioSamplingRate="88200" />
        <Representation audioSamplingRate='192000' codecs='flac' id='audio,1,24' />
      </MPD>
    `;
    let requestedUrl: URL | undefined;
    let requestedHeaders: Headers | undefined;

    await expect(
      loadPlaybackAudioQuality('token', 'client-id', '1', (input, init) => {
        requestedUrl = new URL(
          input instanceof URL
            ? input
            : typeof input === 'string'
              ? input
              : input.url,
        );
        requestedHeaders = new Headers(init?.headers);
        return Promise.resolve(
          Response.json({
            data: {
              attributes: {
                formats: ['FLAC_HIRES'],
                uri: `data:application/dash+xml;base64,${Buffer.from(xml).toString('base64')}`,
              },
            },
          }),
        );
      }),
    ).resolves.toEqual({
      bitDepth: 24,
      format: 'FLAC_HIRES',
      sampleRateHz: 192_000,
    });
    expect(requestedUrl?.pathname).toBe('/v2/trackManifests/1');
    expect(requestedUrl?.searchParams.getAll('formats')).toEqual([
      'HEAACV1',
      'AACLC',
      'FLAC',
      'FLAC_HIRES',
    ]);
    expect(requestedHeaders?.get('authorization')).toBe('Bearer token');
    expect(requestedHeaders?.get('x-playback-session-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('parses complete DASH representations and ignores malformed ones', () => {
    expect(
      parseDashAudioRepresentations(`
        <Representation id="audio,0,16" codecs="flac" audioSamplingRate="44100" />
        <Representation id="audio,1,24" codecs="flac" audioSamplingRate="96000" />
        <Representation id="incomplete" codecs="flac" />
      `),
    ).toEqual([
      { bitDepth: 16, codec: 'flac', sampleRateHz: 44_100 },
      { bitDepth: 24, codec: 'flac', sampleRateHz: 96_000 },
    ]);
  });

  it('rejects malformed DASH data URIs', async () => {
    await expect(
      loadPlaybackAudioQuality('token', 'client-id', '1', () =>
        Promise.resolve(
          Response.json({
            data: {
              attributes: {
                formats: ['FLAC_HIRES'],
                uri: 'https://example.test/manifest.mpd',
              },
            },
          }),
        ),
      ),
    ).rejects.toThrow('base64 DASH data URI');
  });

  it('retries manifest requests after TIDAL rate limiting', async () => {
    let requests = 0;
    const xml =
      '<Representation id="audio,0,24" codecs="flac" audioSamplingRate="96000" />';

    await expect(
      loadPlaybackAudioQuality('token', 'client-id', '1', () => {
        requests += 1;
        if (requests === 1) {
          return Promise.resolve(
            new Response(null, {
              headers: { 'Retry-After': '0' },
              status: 429,
            }),
          );
        }
        return Promise.resolve(
          Response.json({
            data: {
              attributes: {
                formats: ['FLAC_HIRES'],
                uri: `data:application/dash+xml;base64,${Buffer.from(xml).toString('base64')}`,
              },
            },
          }),
        );
      }),
    ).resolves.toMatchObject({ bitDepth: 24, sampleRateHz: 96_000 });
    expect(requests).toBe(2);
  });

  it('distinguishes an expired session from a forbidden track manifest', async () => {
    await expect(
      loadPlaybackAudioQuality('token', 'client-id', '1', () =>
        Promise.resolve(Response.json({}, { status: 401 })),
      ),
    ).rejects.toBeInstanceOf(AuthenticationError);

    await expect(
      loadPlaybackAudioQuality('token', 'client-id', '2', () =>
        Promise.resolve(Response.json({}, { status: 403 })),
      ),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('prefilters by media tag before inspecting exact quality', async () => {
    let exactQualityRequests = 0;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/v2/tracks') {
        respondJson(response, tracksPage());
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

    const result = await inspectTrackQuality(
      client,
      [
        { artists: ['Input Artist'], id: '1', title: 'Input One' },
        { artists: ['Input Artist'], id: '2', title: 'Input Two' },
      ],
      {
        mediaTag: 'HIRES_LOSSLESS',
        minBitDepth: 24,
        minSampleRateHz: 80_000,
      },
      (trackId) => {
        exactQualityRequests += 1;
        expect(trackId).toBe('1');
        return Promise.resolve({
          bitDepth: 24,
          format: 'HI_RES_LOSSLESS',
          sampleRateHz: 96_000,
        });
      },
    );

    expect(exactQualityRequests).toBe(1);
    expect(result).toMatchObject({
      candidates: 2,
      inspected: 1,
      mediaTag: 'HIRES_LOSSLESS',
      rejected: [{ id: '2', reason: 'media-tag' }],
    });
    expect(result.tracks).toEqual([
      {
        album: 'Album 1',
        artists: ['Artist 1'],
        audio: {
          bitDepth: 24,
          format: 'HI_RES_LOSSLESS',
          mediaTags: ['HIRES_LOSSLESS'],
          sampleRateHz: 96_000,
        },
        durationSeconds: 182,
        explicit: false,
        id: '1',
        tidalUrl: 'https://tidal.com/browse/track/1',
        title: 'Track 1',
      },
    ]);
  });

  it('propagates authentication failures from exact inspection', async () => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/v2/tracks') {
        respondJson(response, tracksPage(['1']));
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

    await expect(
      inspectTrackQuality(
        client,
        [{ artists: ['Input Artist'], id: '1', title: 'Input One' }],
        {
          mediaTag: 'HIRES_LOSSLESS',
          minBitDepth: 24,
          minSampleRateHz: 80_000,
        },
        () => Promise.reject(new AuthenticationError('Session expired.')),
      ),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('hydrates candidates within the TIDAL filter limit', async () => {
    const requestedBatchSizes: number[] = [];
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/v2/tracks') {
        const ids = url.searchParams
          .getAll('filter[id]')
          .flatMap((value) => value.split(','));
        requestedBatchSizes.push(ids.length);
        if (ids.length > 20) {
          response.writeHead(400).end('Filter accepts at most 20 values');
          return;
        }
        respondJson(response, tracksPage(ids));
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
    const tracks = Array.from({ length: 21 }, (_, index) => ({
      artists: ['Input Artist'],
      id: `${index + 100}`,
      title: `Input ${index + 100}`,
    }));

    const result = await inspectTrackQuality(
      client,
      tracks,
      {
        mediaTag: 'HIRES_LOSSLESS',
        minBitDepth: 24,
        minSampleRateHz: 80_000,
      },
      () => Promise.reject(new Error('Exact inspection should not run.')),
    );

    expect(requestedBatchSizes).toEqual([20, 1]);
    expect(result.candidates).toBe(21);
    expect(result.rejected).toHaveLength(21);
  });
});

function tracksPage(ids = ['1', '2']) {
  return {
    data: ids.map((id) => ({
      attributes: {
        duration: 'PT3M2S',
        explicit: false,
        externalLinks: [],
        mediaTags: id === '1' ? ['HIRES_LOSSLESS'] : [],
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
