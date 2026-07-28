import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import {
  runFavoritesAdd,
  runPlaylistCreate,
  runPlaylistSetTracks,
} from '../src/commands/library.js';
import { OutputFormat } from '../src/output.js';
import { initializeLibrary, loadLibrary } from '../src/storage/library.js';

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

describe('agent-safe local music commands', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it('creates playlists and adds typed favorite tracks atomically', async () => {
    const root = await temporaryRoot();
    await initializeLibrary(root, 'US');
    const streams = { stderr: new BufferStream(), stdout: new BufferStream() };
    const tracksPath = join(root, 'tracks.json');
    await writeFile(
      tracksPath,
      JSON.stringify([
        { artists: ['Artist'], id: 'track-1', title: 'Track One' },
      ]),
    );

    await runPlaylistCreate(root, 'Focus', '', OutputFormat.json, streams);
    await runFavoritesAdd(root, tracksPath, OutputFormat.json, streams);

    await expect(loadLibrary(root)).resolves.toMatchObject({
      favorites: { tracks: [{ id: 'track-1' }] },
      playlists: [{ title: 'Focus' }],
    });
    expect(streams.stdout.toString()).toContain('"status": "updated"');
  });

  it('does not rewrite playlists containing unavailable tracks', async () => {
    const root = await temporaryRoot();
    await initializeLibrary(root, 'US');
    const streams = { stderr: new BufferStream(), stdout: new BufferStream() };
    await runPlaylistCreate(
      root,
      'Unavailable',
      '',
      OutputFormat.json,
      streams,
    );
    const library = await loadLibrary(root);
    const playlist = library.playlists[0];
    if (!playlist?.localId) {
      throw new Error('Expected the created playlist local ID.');
    }
    const initialTracks = join(root, 'initial.json');
    const replacementTracks = join(root, 'replacement.json');
    await writeFile(
      initialTracks,
      JSON.stringify([
        {
          artists: ['Unavailable'],
          id: 'track-1',
          title: 'Unavailable',
          unavailable: true,
        },
      ]),
    );
    await writeFile(
      replacementTracks,
      JSON.stringify([
        { artists: ['Artist'], id: 'track-2', title: 'Replacement' },
      ]),
    );

    await runPlaylistSetTracks(
      root,
      playlist.localId,
      initialTracks,
      OutputFormat.json,
      streams,
    );
    await expect(
      runPlaylistSetTracks(
        root,
        playlist.localId,
        replacementTracks,
        OutputFormat.json,
        streams,
      ),
    ).rejects.toThrow(/contains unavailable tracks/);
  });

  async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'tidekeeper-library-command-'));
    temporaryRoots.push(root);
    return root;
  }
});
