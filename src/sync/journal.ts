import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { ValidationError } from '../errors.js';
import { pathExists, writeTextFileAtomic } from '../storage/yaml.js';
import type { SyncPlan } from './plan.js';

const trackSchema = z
  .object({
    addedAt: z.string().optional(),
    album: z.string().optional(),
    artists: z.array(z.string()),
    durationSeconds: z.number().optional(),
    explicit: z.boolean().optional(),
    id: z.string(),
    itemId: z.string().optional(),
    tidalUrl: z.string().optional(),
    title: z.string(),
  })
  .strict();

const operationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('favorites.add'),
    trackIds: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('favorites.remove'),
    trackIds: z.array(z.string()),
  }),
  z.object({
    description: z.string(),
    kind: z.literal('playlist.create'),
    localId: z.string(),
    title: z.string(),
    trackIds: z.array(z.string()),
  }),
  z.object({
    currentDescription: z.string(),
    currentTracks: z.array(trackSchema),
    kind: z.literal('playlist.delete'),
    playlistId: z.string(),
    title: z.string(),
  }),
  z.object({
    currentTracks: z.array(trackSchema),
    kind: z.literal('playlist.replaceTracks'),
    playlistId: z.string(),
    title: z.string(),
    trackIds: z.array(z.string()),
  }),
  z.object({
    currentDescription: z.string(),
    currentTitle: z.string(),
    description: z.string(),
    kind: z.literal('playlist.update'),
    playlistId: z.string(),
    title: z.string(),
  }),
]);

const syncPlanSchema: z.ZodType<SyncPlan> = z
  .object({
    digest: z.string(),
    hasRemovals: z.boolean(),
    localFingerprint: z.string(),
    operations: z.array(operationSchema),
    remoteFingerprint: z.string(),
  })
  .strict();

const journalSchema = z
  .object({
    completedOperations: z.array(z.number().int().nonnegative()),
    createdPlaylistIds: z.record(z.string(), z.string()),
    finalRemoteContentFingerprint: z.string().optional(),
    finalRemoteFingerprint: z.string().optional(),
    initialLocalContentFingerprint: z.string(),
    phase: z.enum(['applying', 'finalizing']),
    plan: syncPlanSchema,
    startedOperations: z.array(z.number().int().nonnegative()),
    version: z.literal(2),
  })
  .strict()
  .superRefine((journal, context) => {
    if (
      journal.phase === 'finalizing' &&
      (!journal.finalRemoteFingerprint ||
        !journal.finalRemoteContentFingerprint)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A finalizing journal requires remote fingerprints.',
      });
    }
  });

export type PushJournal = z.infer<typeof journalSchema>;

export async function loadPushJournal(
  root: string,
): Promise<PushJournal | undefined> {
  const path = journalPath(root);
  if (!(await pathExists(path))) {
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error: unknown) {
    throw new ValidationError(`Unable to parse sync journal ${path}.`, {
      cause: error,
    });
  }
  const parsed = journalSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(`Invalid sync journal ${path}.`);
  }
  return parsed.data;
}

export async function savePushJournal(
  root: string,
  journal: PushJournal,
): Promise<void> {
  const parsed = journalSchema.parse(journal);
  await writeTextFileAtomic(
    journalPath(root),
    `${JSON.stringify(parsed, null, 2)}\n`,
  );
}

export async function deletePushJournal(root: string): Promise<void> {
  await rm(journalPath(root), { force: true });
}

function journalPath(root: string): string {
  return join(root, '.tidekeeper', 'journal', 'push.json');
}
