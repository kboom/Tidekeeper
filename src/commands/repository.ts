import type { OutputFormatValue, OutputStreams } from '../output.js';
import { writeOutput } from '../output.js';
import {
  createRepository,
  upgradeRepository,
  verifyRepository,
  type RepositoryCreateDependencies,
} from '../repository/service.js';
import {
  publishGitHubRepository,
  type GitHubRepositoryPublishOptions,
  type GitHubRepositoryPublishResult,
} from '../repository/github.js';

export async function runRepositoryCreate(
  options: {
    countryCode: string;
    ephemeralSession?: boolean;
    gitEmail?: string;
    gitName?: string;
    github?: boolean;
    githubRepository?: string;
    githubVisibility?: 'private' | 'public';
    output: OutputFormatValue;
    target: string;
  },
  streams: OutputStreams,
  dependencies?: RepositoryCreateDependencies,
): Promise<void> {
  const result = await createRepository(options, dependencies);
  writeOutput(streams.stdout, options.output, result, [result]);
}

export async function runRepositoryPublish(
  options: GitHubRepositoryPublishOptions & { output: OutputFormatValue },
  streams: OutputStreams,
  publish: (
    options: GitHubRepositoryPublishOptions,
  ) => Promise<GitHubRepositoryPublishResult> = publishGitHubRepository,
): Promise<void> {
  const { output, ...publishOptions } = options;
  const result = await publish(publishOptions);
  writeOutput(streams.stdout, output, result, [result]);
}

export async function runRepositoryVerify(
  options: { output: OutputFormatValue; root: string },
  streams: OutputStreams,
): Promise<void> {
  const result = await verifyRepository(options.root);
  writeOutput(streams.stdout, options.output, result, [result]);
}

export async function runRepositoryUpgrade(
  options: { output: OutputFormatValue; root: string },
  streams: OutputStreams,
): Promise<void> {
  const result = await upgradeRepository(options.root);
  writeOutput(streams.stdout, options.output, result, [result]);
}
