import { z } from 'zod';

import type {
  FavoritesDocument,
  PlaylistDocument,
  TidekeeperConfig,
  TrackReference,
} from '../domain.js';

const safeRelativePathPattern =
  /^(?![a-zA-Z]:)(?![/\\])(?!.*(?:^|[/\\])\.\.(?:[/\\]|$)).+$/;

export const trackReferenceSchema: z.ZodType<TrackReference> = z
  .object({
    addedAt: z
      .string()
      .refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid timestamp')
      .optional(),
    album: z.string().min(1).optional(),
    artists: z.array(z.string().min(1)).min(1),
    durationSeconds: z.number().int().nonnegative().optional(),
    explicit: z.boolean().optional(),
    id: z.string().min(1),
    itemId: z.string().min(1).optional(),
    tidalUrl: z.url().optional(),
    title: z.string().min(1),
    unavailable: z.boolean().optional(),
  })
  .strict();

export const favoritesDocumentSchema: z.ZodType<FavoritesDocument> = z
  .object({
    kind: z.literal('favorites'),
    schemaVersion: z.literal(1),
    tracks: z.array(trackReferenceSchema),
  })
  .strict()
  .superRefine((document, context) => {
    const seen = new Set<string>();
    document.tracks.forEach((track, index) => {
      if (seen.has(track.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate favorite track ID: ${track.id}`,
          path: ['tracks', index, 'id'],
        });
      }
      seen.add(track.id);
    });
  });

export const playlistDocumentSchema: z.ZodType<PlaylistDocument> = z
  .object({
    description: z.string().max(2_000).default(''),
    id: z.string().min(1).nullable(),
    kind: z.literal('playlist'),
    localId: z.uuid().optional(),
    schemaVersion: z.literal(1),
    title: z.string().min(1).max(255),
    tracks: z.array(trackReferenceSchema),
  })
  .strict()
  .superRefine((document, context) => {
    if (document.id === null && document.localId === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'A local playlist requires localId when id is null.',
        path: ['localId'],
      });
    }
  });

export const tidekeeperConfigSchema: z.ZodType<TidekeeperConfig> = z
  .object({
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/, 'Expected an ISO 3166-1 alpha-2 country code')
      .optional(),
    libraryDirectory: z
      .string()
      .regex(
        safeRelativePathPattern,
        'Library directory must be a safe relative path',
      )
      .default('library'),
    schemaVersion: z.literal(1),
  })
  .strict();
