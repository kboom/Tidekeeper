import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'npm_execpath is required to inspect the package');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'tidekeeper-package-'));

try {
  const { stdout: packOutput } = await execFileAsync(
    process.execPath,
    [npmCli, 'pack', '--json', '--dry-run', '--ignore-scripts'],
    { cwd: projectRoot, encoding: 'utf8', windowsHide: true },
  );
  const [packageInfo] = JSON.parse(packOutput);
  assert.ok(packageInfo, 'npm pack did not describe a package');
  const files = packageInfo.files.map((file) => file.path);
  for (const required of [
    'LICENSE',
    'README.md',
    'dist/index.js',
    'dist/auth/service.js',
    'dist/sync/service.js',
    'dist/tidal/playlists.js',
    'dist/repository/service.js',
    'dist/repository/template.js',
    'templates/repository/.github/skills/music-discovery/SKILL.md',
    'templates/repository/.github/skills/music-library-audit/SKILL.md',
    'templates/repository/.github/skills/music-profile/SKILL.md',
    'templates/repository/.github/skills/music-profile/scoring.md',
    'templates/repository/.github/skills/playlist-curator/SKILL.md',
    'templates/repository/.github/skills/tidal-sync-review/SKILL.md',
    'package.json',
  ]) {
    assert.ok(files.includes(required), `package is missing ${required}`);
  }
  assert.equal(
    files.some(
      (path) =>
        path.startsWith('src/') ||
        path.startsWith('test/') ||
        path.startsWith('dist/src/'),
    ),
    false,
    'package contains source, tests, or stale nested build output',
  );

  const executable = join(projectRoot, 'dist', 'index.js');
  assert.match(
    await readFile(executable, 'utf8'),
    /^#!\/usr\/bin\/env node\r?\n/u,
    'compiled CLI is missing its Node.js shebang',
  );

  const { stdout: helpOutput } = await execFileAsync(
    process.execPath,
    [executable, '--help'],
    { cwd: projectRoot, encoding: 'utf8', windowsHide: true },
  );
  assert.match(helpOutput, /Usage: tidekeeper/u);
  assert.match(helpOutput, /repo/u);

  const { stdout: initOutput } = await execFileAsync(
    process.execPath,
    [
      executable,
      '--root',
      temporaryRoot,
      '--output',
      'json',
      'init',
      '--country-code',
      'US',
    ],
    { cwd: projectRoot, encoding: 'utf8', windowsHide: true },
  );
  assert.equal(JSON.parse(initOutput).status, 'initialized');
  await Promise.all([
    readFile(join(temporaryRoot, 'tidekeeper.yaml'), 'utf8'),
    readFile(join(temporaryRoot, 'library', 'favorites.yaml'), 'utf8'),
  ]);
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
