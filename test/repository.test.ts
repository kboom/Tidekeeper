import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createRepository,
  upgradeRepository,
  verifyRepository,
} from '../src/repository/service.js';
import { createTemplateManifest } from '../src/repository/template.js';

const execFileAsync = promisify(execFile);

describe('agent-ready repository generator', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it('creates a two-commit repository with verified generated Copilot assets', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'tidekeeper-repository-'));
    temporaryRoots.push(parent);
    const target = join(parent, 'music library');

    const result = await createRepository(
      {
        countryCode: 'US',
        gitEmail: 'test@example.com',
        gitName: 'Tidekeeper Test',
        target,
      },
      {
        authStatus: () =>
          Promise.resolve({
            authenticated: true,
            grantedScopes: ['playlists.read'],
          }),
        login: () => {
          throw new Error('login should not be required for an active session');
        },
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
            favorites: {
              kind: 'favorites',
              schemaVersion: 1,
              tracks: [{ artists: ['Artist'], id: 'track-1', title: 'Track' }],
            },
            playlists: [
              {
                description: 'A playlist',
                id: 'playlist-1',
                kind: 'playlist',
                schemaVersion: 1,
                title: 'Focus',
                tracks: [
                  { artists: ['Artist'], id: 'track-1', title: 'Track' },
                ],
              },
            ],
          }),
      },
    );

    expect(result).toEqual({
      favoriteTracks: 1,
      githubRepository: 'test-user/Tidal',
      githubUrl: 'https://github.com/test-user/Tidal',
      githubVisibility: 'private',
      playlists: 1,
      status: 'created',
      target,
      tracksInPlaylists: 1,
    });
    expect(await verifyRepository(target)).toMatchObject({
      favoriteTracks: 1,
      generatedFiles: Object.keys(createTemplateManifest().generatedFiles)
        .length,
      playlists: 1,
      status: 'valid',
    });

    const { stdout: log } = await execFileAsync(
      'git',
      ['-C', target, 'log', '--format=%s'],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(log.trim().split(/\r?\n/u)).toEqual([
      'Import TIDAL music library',
      'Initialize Tidekeeper music repository',
    ]);
    await expect(
      readFile(
        join(target, '.github', 'skills', 'tidal-sync-review', 'SKILL.md'),
        'utf8',
      ),
    ).resolves.toContain('Never run `sync push --apply`.');
    await expect(
      readFile(
        join(target, '.github', 'skills', 'music-profile', 'SKILL.md'),
        'utf8',
      ),
    ).resolves.toContain('What makes it click');
    await expect(
      readFile(
        join(target, '.github', 'skills', 'music-profile', 'scoring.md'),
        'utf8',
      ),
    ).resolves.toContain('Anti-bounce discipline');
    expect(createTemplateManifest().generatedFiles).toHaveProperty(
      '.github/skills/music-profile/scoring.md',
    );
    await expect(
      readFile(join(target, '.tidekeeper', 'run-tidekeeper.mjs'), 'utf8'),
    ).resolves.toContain('const child = spawn(process.execPath');
    await expect(
      readFile(join(target, '.github', 'tidekeeper-cli.md'), 'utf8'),
    ).resolves.toContain('npm run tidekeeper -- library playlist --help');
    await expect(
      readFile(join(target, 'package.json'), 'utf8'),
    ).resolves.toContain('"tidekeeper": "node .tidekeeper/run-tidekeeper.mjs"');
  });

  it('rejects modified generated assets during verification and upgrade', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'tidekeeper-repository-'));
    temporaryRoots.push(parent);
    const target = join(parent, 'music');
    await createEmptyRepository(target);

    const instructions = join(target, '.github', 'copilot-instructions.md');
    await rm(instructions);

    await expect(verifyRepository(target)).rejects.toThrow(
      /Required repository file is missing/,
    );
    await expect(upgradeRepository(target)).rejects.toThrow(
      /Required repository file is missing/,
    );
  });

  it('preserves user-owned preferences while upgrading generated skills', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'tidekeeper-repository-'));
    temporaryRoots.push(parent);
    const target = join(parent, 'music');
    await createEmptyRepository(target);
    const manifestPath = join(target, '.tidekeeper-template.json');
    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf8'),
    ) as ReturnType<typeof createTemplateManifest>;
    manifest.templateVersion = 4;
    manifest.generatedFiles = Object.fromEntries(
      Object.entries(manifest.generatedFiles).filter(
        ([path]) => !path.startsWith('.github/skills/music-profile/'),
      ),
    );
    await rm(join(target, '.github', 'skills', 'music-profile'), {
      recursive: true,
    });
    await writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    const preferences = join(target, 'music-preferences.md');
    const userPreferences =
      '# Music preferences\n\n## Your notes\n\n- Keep this.\n';
    await writeFile(preferences, userPreferences, 'utf8');

    await upgradeRepository(target);

    await expect(readFile(preferences, 'utf8')).resolves.toBe(userPreferences);
    await expect(readFile(manifestPath, 'utf8')).resolves.toContain(
      '"templateVersion": 5',
    );
    await expect(
      readFile(
        join(target, '.github', 'skills', 'music-profile', 'scoring.md'),
        'utf8',
      ),
    ).resolves.toContain('same library must always produce');
  });

  async function createEmptyRepository(target: string): Promise<void> {
    await createRepository(
      {
        countryCode: 'US',
        gitEmail: 'test@example.com',
        gitName: 'Tidekeeper Test',
        target,
      },
      {
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
    );
  }
});
