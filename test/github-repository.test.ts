import { describe, expect, it } from 'vitest';

import { publishGitHubRepository } from '../src/repository/github.js';

type Invocation = {
  args: readonly string[];
  command: string;
};

describe('GitHub repository publishing', () => {
  it('reports GitHub authentication failures before inspecting remotes', async () => {
    await expect(
      publishGitHubRepository(
        { root: 'X:\\Tidal' },
        {
          execute: (command, args) => {
            if (command === 'git' && args.includes('rev-parse')) {
              return Promise.resolve('true');
            }
            return Promise.reject(new Error('not authenticated'));
          },
        },
      ),
    ).rejects.toThrow(
      'GitHub CLI is not authenticated. Run "gh auth login --hostname github.com" and retry.',
    );
  });

  it('creates a private personal repository, configures origin, and pushes HEAD', async () => {
    const invocations: Invocation[] = [];
    const result = await publishGitHubRepository(
      { root: 'X:\\Tidal' },
      {
        execute: (command, args) => {
          invocations.push({ args, command });
          if (command === 'gh' && args[0] === 'api' && args[1] === 'user') {
            return Promise.resolve('kboom\n');
          }
          if (command === 'gh' && args[0] === 'repo' && args[1] === 'list') {
            return Promise.resolve('[]');
          }
          if (command === 'git' && args.includes('rev-parse')) {
            return Promise.resolve('true\n');
          }
          if (command === 'git' && args.at(-1) === 'remote') {
            return Promise.resolve('');
          }
          return Promise.resolve('');
        },
      },
    );

    expect(result).toEqual({
      owner: 'kboom',
      repository: 'kboom/Tidal',
      status: 'published',
      url: 'https://github.com/kboom/Tidal',
      visibility: 'private',
    });
    expect(invocations).toContainEqual({
      command: 'gh',
      args: ['repo', 'create', 'kboom/Tidal', '--private'],
    });
    expect(invocations).toContainEqual({
      command: 'git',
      args: [
        '-C',
        'X:\\Tidal',
        'remote',
        'add',
        'origin',
        'https://github.com/kboom/Tidal.git',
      ],
    });
    expect(invocations.at(-1)).toEqual({
      command: 'git',
      args: ['-C', 'X:\\Tidal', 'push', '--set-upstream', 'origin', 'HEAD'],
    });
  });

  it('resumes by attaching an existing empty repository', async () => {
    const invocations: Invocation[] = [];
    await publishGitHubRepository(
      {
        repositoryName: 'Music',
        root: 'X:\\Music',
        visibility: 'public',
      },
      {
        execute: (command, args) => {
          invocations.push({ args, command });
          if (command === 'gh' && args[1] === 'user') {
            return Promise.resolve('kboom');
          }
          if (command === 'gh' && args[0] === 'repo' && args[1] === 'list') {
            return Promise.resolve(
              '[{"isEmpty":true,"nameWithOwner":"kboom/Music","url":"https://github.com/kboom/Music","visibility":"PUBLIC"}]',
            );
          }
          if (command === 'git' && args.includes('rev-parse')) {
            return Promise.resolve('true');
          }
          if (command === 'git' && args.at(-1) === 'remote') {
            return Promise.resolve('');
          }
          return Promise.resolve('');
        },
      },
    );

    expect(
      invocations.some(
        ({ args, command }) =>
          command === 'gh' && args[0] === 'repo' && args[1] === 'create',
      ),
    ).toBe(false);
    expect(invocations).toContainEqual({
      command: 'git',
      args: [
        '-C',
        'X:\\Music',
        'remote',
        'add',
        'origin',
        'https://github.com/kboom/Music.git',
      ],
    });
  });

  it('refuses to attach an existing non-empty repository without origin', async () => {
    await expect(
      publishGitHubRepository(
        { root: 'X:\\Tidal' },
        {
          execute: (command, args) => {
            if (command === 'gh' && args[1] === 'user') {
              return Promise.resolve('kboom');
            }
            if (command === 'gh' && args[0] === 'repo' && args[1] === 'list') {
              return Promise.resolve(
                '[{"isEmpty":false,"nameWithOwner":"kboom/Tidal","url":"https://github.com/kboom/Tidal","visibility":"PRIVATE"}]',
              );
            }
            if (command === 'git' && args.includes('rev-parse')) {
              return Promise.resolve('true');
            }
            return Promise.resolve('');
          },
        },
      ),
    ).rejects.toThrow(/already contains commits/);
  });

  it('refuses to replace an unrelated origin', async () => {
    await expect(
      publishGitHubRepository(
        { root: 'X:\\Tidal' },
        {
          execute: (command, args) => {
            if (command === 'gh') {
              return Promise.resolve('kboom');
            }
            if (args.includes('rev-parse')) {
              return Promise.resolve('true');
            }
            if (args.at(-1) === 'remote') {
              return Promise.resolve('origin\n');
            }
            if (args.includes('get-url')) {
              return Promise.resolve('https://github.com/someone/other.git\n');
            }
            return Promise.resolve('');
          },
        },
      ),
    ).rejects.toThrow(/Refusing to replace it/);
  });

  it('reports an exact retry command when the push fails', async () => {
    await expect(
      publishGitHubRepository(
        { root: 'X:\\Tidal' },
        {
          execute: (command, args) => {
            if (command === 'gh' && args[1] === 'user') {
              return Promise.resolve('kboom');
            }
            if (command === 'gh' && args[0] === 'repo' && args[1] === 'list') {
              return Promise.resolve(
                '[{"isEmpty":true,"nameWithOwner":"kboom/Tidal","url":"https://github.com/kboom/Tidal","visibility":"PRIVATE"}]',
              );
            }
            if (command === 'git' && args.includes('rev-parse')) {
              return Promise.resolve('true');
            }
            if (command === 'git' && args.at(-1) === 'remote') {
              return Promise.resolve('origin\n');
            }
            if (command === 'git' && args.includes('get-url')) {
              return Promise.resolve('git@github.com:kboom/Tidal.git\n');
            }
            if (command === 'git' && args.includes('push')) {
              return Promise.reject(new Error('network unavailable'));
            }
            return Promise.resolve('');
          },
        },
      ),
    ).rejects.toThrow(
      'tidekeeper --root "X:\\\\Tidal" repo publish --github-repo "Tidal" --github-visibility private',
    );
  });
});
