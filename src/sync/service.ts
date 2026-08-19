import type {
  LibrarySnapshot,
  PlaylistDocument,
  TrackReference,
} from '../domain.js';
import {
  AuthenticationError,
  ConflictError,
  PartialApplyError,
} from '../errors.js';
import {
  loadLibrary,
  recoverLibraryReplacement,
  writeLibrarySnapshot,
} from '../storage/library.js';
import type { TidalApiClient } from '../tidal/client.js';
import { addFavoriteTracks, removeFavoriteTracks } from '../tidal/favorites.js';
import {
  createPlaylist,
  deletePlaylist,
  replacePlaylistTracks,
  updatePlaylist,
} from '../tidal/playlists.js';
import { getRemoteSnapshot } from '../tidal/snapshot.js';
import { assertManagedFilesClean } from './git.js';
import {
  deletePushJournal,
  loadPushJournal,
  savePushJournal,
  type PushJournal,
} from './journal.js';
import { withSyncLock } from './lock.js';
import {
  buildSyncPlan,
  fingerprintSnapshot,
  fingerprintSnapshotContent,
  type SyncOperation,
  type SyncPlan,
} from './plan.js';

export type PullResult = {
  applied: boolean;
  changed: boolean;
  remoteFingerprint: string;
};

export type PushOptions = {
  allowDirty?: boolean;
  allowRemovals?: boolean;
};

export type PushResult = {
  appliedOperations: number;
  plan: SyncPlan;
};

export async function planPush(
  client: TidalApiClient,
  root: string,
): Promise<SyncPlan> {
  const local = await loadLibrary(root);
  const remote = await getRemoteSnapshot(client, local.config);
  return buildSyncPlan(local, remote);
}

export async function pullRemote(
  client: TidalApiClient,
  root: string,
  apply: boolean,
  force = false,
): Promise<PullResult> {
  if (apply) {
    return withSyncLock(root, async () => {
      await recoverLibraryReplacement(root);
      return pullRemoteUnlocked(client, root, apply, force);
    });
  }
  return pullRemoteUnlocked(client, root, apply, force);
}

async function pullRemoteUnlocked(
  client: TidalApiClient,
  root: string,
  apply: boolean,
  force: boolean,
): Promise<PullResult> {
  const local = await loadLibrary(root);
  const remote = await getRemoteSnapshot(client, local.config);
  const changed = fingerprintSnapshot(local) !== fingerprintSnapshot(remote);

  if (apply && changed) {
    if (!force) {
      await assertManagedFilesClean(
        root,
        'pull',
        local.config.libraryDirectory,
      );
    }
    await writeLibrarySnapshot(root, remote);
  }

  return {
    applied: apply && changed,
    changed,
    remoteFingerprint: fingerprintSnapshot(remote),
  };
}

export async function pushLocal(
  client: TidalApiClient,
  root: string,
  options: PushOptions = {},
): Promise<PushResult> {
  return withSyncLock(root, async () => {
    await recoverLibraryReplacement(root);
    return pushLocalUnlocked(client, root, options);
  });
}

async function pushLocalUnlocked(
  client: TidalApiClient,
  root: string,
  options: PushOptions,
): Promise<PushResult> {
  const local = await loadLibrary(root);
  const activeJournal = await loadPushJournal(root);
  if (activeJournal) {
    if (activeJournal.plan.hasRemovals && !options.allowRemovals) {
      throw new ConflictError(
        'The interrupted push removes remote data. Re-run with --allow-removals to resume it.',
      );
    }
    if (activeJournal.phase === 'finalizing') {
      return resumeFinalization(client, root, local, activeJournal);
    }
    if (
      fingerprintSnapshotContent(local) !==
      activeJournal.initialLocalContentFingerprint
    ) {
      throw new ConflictError(
        'Local managed files changed after the interrupted push. Restore them before resuming.',
      );
    }
    if (!options.allowDirty) {
      await assertManagedFilesClean(
        root,
        'push',
        local.config.libraryDirectory,
      );
    }

    let remote: LibrarySnapshot;
    try {
      await recoverCreatedPlaylistIds(client, root, local, activeJournal);
      remote = await getRemoteSnapshot(client, local.config);
    } catch (error: unknown) {
      throwAsPartialApply(error);
    }
    assertResumeCompatible(local, remote, activeJournal);
    return applyJournal(client, root, local, activeJournal);
  }

  if (!options.allowDirty) {
    await assertManagedFilesClean(root, 'push', local.config.libraryDirectory);
  }

  const remote = await getRemoteSnapshot(client, local.config);
  const plan = buildSyncPlan(local, remote);
  if (plan.hasRemovals && !options.allowRemovals) {
    throw new ConflictError(
      'The push plan removes remote data. Re-run with --allow-removals after reviewing the plan.',
    );
  }

  const freshRemote = await getRemoteSnapshot(client, local.config);
  if (fingerprintSnapshot(freshRemote) !== plan.remoteFingerprint) {
    throw new ConflictError(
      'TIDAL changed while the push was being planned. Re-run the command.',
    );
  }

  const journal: PushJournal = {
    completedOperations: [],
    createdPlaylistIds: {},
    initialLocalContentFingerprint: fingerprintSnapshotContent(local),
    phase: 'applying',
    plan,
    startedOperations: [],
    version: 2,
  };
  await savePushJournal(root, journal);
  return applyJournal(client, root, local, journal);
}

async function applyJournal(
  client: TidalApiClient,
  root: string,
  local: LibrarySnapshot,
  journal: PushJournal,
): Promise<PushResult> {
  try {
    for (const [index, operation] of journal.plan.operations.entries()) {
      if (journal.completedOperations.includes(index)) {
        continue;
      }
      if (!journal.startedOperations.includes(index)) {
        journal.startedOperations.push(index);
        await savePushJournal(root, journal);
      }
      await applyOperation(
        client,
        operation,
        operationKey(journal.plan.digest, index),
        local.config.countryCode,
        journal.createdPlaylistIds[String(index)],
        async (playlistId) => {
          journal.createdPlaylistIds[String(index)] = playlistId;
          await savePushJournal(root, journal);
        },
      );
      journal.completedOperations.push(index);
      await savePushJournal(root, journal);
    }

    const completedRemote = await getCompletedRemoteSnapshot(
      client,
      local,
      journal,
    );
    const synchronized = createSynchronizedSnapshot(
      local,
      journal,
      completedRemote,
    );
    journal.finalRemoteContentFingerprint =
      fingerprintSnapshotContent(synchronized);
    journal.finalRemoteFingerprint = fingerprintSnapshot(completedRemote);
    journal.phase = 'finalizing';
    await savePushJournal(root, journal);
    await writeLibrarySnapshot(root, synchronized);
    await deletePushJournal(root);
    return {
      appliedOperations: journal.plan.operations.length,
      plan: journal.plan,
    };
  } catch (error: unknown) {
    throwAsPartialApply(error);
  }
}

async function resumeFinalization(
  client: TidalApiClient,
  root: string,
  local: LibrarySnapshot,
  journal: PushJournal,
): Promise<PushResult> {
  const localContentFingerprint = fingerprintSnapshotContent(local);
  if (
    localContentFingerprint !== journal.initialLocalContentFingerprint &&
    localContentFingerprint !== journal.finalRemoteContentFingerprint
  ) {
    throw new ConflictError(
      'Local managed files changed while the interrupted push was being finalized.',
    );
  }

  let remote: LibrarySnapshot;
  try {
    remote = await getRemoteSnapshot(client, local.config);
  } catch (error: unknown) {
    throwAsPartialApply(error);
  }
  const synchronized = createSynchronizedSnapshot(local, journal, remote);
  if (fingerprintSnapshot(remote) !== journal.finalRemoteFingerprint) {
    try {
      journal.finalRemoteContentFingerprint =
        fingerprintSnapshotContent(synchronized);
      journal.finalRemoteFingerprint = fingerprintSnapshot(remote);
      await savePushJournal(root, journal);
      await writeLibrarySnapshot(root, synchronized);
      await deletePushJournal(root);
    } catch (error: unknown) {
      throwAsPartialApply(error);
    }
    throw new ConflictError(
      'TIDAL changed after the push completed remotely. The local snapshot was refreshed; review and commit it before pushing again.',
    );
  }

  try {
    await writeLibrarySnapshot(root, synchronized);
    await deletePushJournal(root);
  } catch (error: unknown) {
    throwAsPartialApply(error);
  }
  return {
    appliedOperations: journal.plan.operations.length,
    plan: journal.plan,
  };
}

function createSynchronizedSnapshot(
  local: LibrarySnapshot,
  journal: PushJournal,
  remote: LibrarySnapshot,
): LibrarySnapshot {
  return mergeLocalOnlyUnavailableTracks(
    mapCreatedPlaylistIds(local, journal),
    remote,
  );
}

export async function snapshotForPullPreview(
  client: TidalApiClient,
  root: string,
): Promise<{
  changed: boolean;
  local: LibrarySnapshot;
  remote: LibrarySnapshot;
}> {
  const local = await loadLibrary(root);
  const remote = await getRemoteSnapshot(client, local.config);
  return {
    changed: fingerprintSnapshot(local) !== fingerprintSnapshot(remote),
    local,
    remote,
  };
}

async function applyOperation(
  client: TidalApiClient,
  operation: SyncOperation,
  idempotencyKey: string,
  countryCode?: string,
  createdPlaylistId?: string,
  onPlaylistCreated?: (playlistId: string) => Promise<void>,
): Promise<void> {
  switch (operation.kind) {
    case 'favorites.add':
      await addFavoriteTracks(client, operation.trackIds, idempotencyKey);
      return;
    case 'favorites.remove':
      await removeFavoriteTracks(client, operation.trackIds, idempotencyKey);
      return;
    case 'playlist.create': {
      const playlistId =
        createdPlaylistId ??
        (await createPlaylist(
          client,
          {
            description: operation.description,
            title: operation.title,
          },
          idempotencyKey,
          countryCode,
        ));
      if (!createdPlaylistId) {
        await onPlaylistCreated?.(playlistId);
      }
      await replacePlaylistTracks(
        client,
        playlistId,
        [],
        operation.trackIds,
        `${idempotencyKey}-tracks`,
        countryCode,
      );
      return;
    }
    case 'playlist.delete':
      await deletePlaylist(client, operation.playlistId, idempotencyKey);
      return;
    case 'playlist.replaceTracks':
      await replacePlaylistTracks(
        client,
        operation.playlistId,
        operation.currentTracks,
        operation.trackIds,
        idempotencyKey,
        countryCode,
      );
      return;
    case 'playlist.update':
      await updatePlaylist(
        client,
        operation.playlistId,
        {
          description: operation.description,
          title: operation.title,
        },
        idempotencyKey,
        countryCode,
      );
      return;
  }
}

function operationKey(planDigest: string, index: number): string {
  return `tidekeeper-${planDigest.slice(0, 40)}-${index}`;
}

async function recoverCreatedPlaylistIds(
  client: TidalApiClient,
  root: string,
  local: LibrarySnapshot,
  journal: PushJournal,
): Promise<void> {
  for (const index of journal.startedOperations) {
    const operation = journal.plan.operations[index];
    if (
      operation?.kind !== 'playlist.create' ||
      journal.completedOperations.includes(index) ||
      journal.createdPlaylistIds[String(index)]
    ) {
      continue;
    }
    const playlistId = await createPlaylist(
      client,
      {
        description: operation.description,
        title: operation.title,
      },
      operationKey(journal.plan.digest, index),
      local.config.countryCode,
    );
    journal.createdPlaylistIds[String(index)] = playlistId;
    await savePushJournal(root, journal);
  }
}

function assertResumeCompatible(
  local: LibrarySnapshot,
  remote: LibrarySnapshot,
  journal: PushJournal,
): void {
  const mappedLocal = mapCreatedPlaylistIds(local, journal);
  let currentOperations: SyncOperation[];
  try {
    currentOperations = buildSyncPlan(mappedLocal, remote).operations;
  } catch (error: unknown) {
    throw new ConflictError(
      'TIDAL no longer matches a safely resumable state for this push.',
      { cause: error },
    );
  }
  const expected = journal.plan.operations
    .map((operation, index) => ({ index, operation }))
    .filter(({ index }) => !journal.completedOperations.includes(index));
  let expectedIndex = 0;
  for (const current of currentOperations) {
    while (expectedIndex < expected.length) {
      const candidate = expected[expectedIndex];
      if (
        !candidate ||
        operationsAreResumeCompatible(current, candidate, journal)
      ) {
        break;
      }
      expectedIndex += 1;
    }
    if (expectedIndex >= expected.length) {
      throw new ConflictError(
        'TIDAL changed outside the interrupted push. Pull and reconcile before resuming.',
      );
    }
    expectedIndex += 1;
  }
}

function mapCreatedPlaylistIds(
  local: LibrarySnapshot,
  journal: PushJournal,
): LibrarySnapshot {
  const mappedLocal = structuredClone(local);
  for (const [indexText, playlistId] of Object.entries(
    journal.createdPlaylistIds,
  )) {
    const operation = journal.plan.operations[Number(indexText)];
    if (operation?.kind !== 'playlist.create') {
      throw new ConflictError('The push journal has an invalid playlist map.');
    }
    const playlist = mappedLocal.playlists.find(
      (candidate) => candidate.localId === operation.localId,
    );
    if (!playlist) {
      throw new ConflictError(
        `The local playlist ${operation.localId} is missing while resuming.`,
      );
    }
    playlist.id = playlistId;
  }
  return mappedLocal;
}

function mergeLocalOnlyUnavailableTracks(
  local: LibrarySnapshot,
  remote: LibrarySnapshot,
): LibrarySnapshot {
  const merged = structuredClone(remote);
  const localFavoritesById = new Map(
    local.favorites.tracks.map((track) => [track.id, track]),
  );
  merged.favorites.tracks = merged.favorites.tracks.map((remoteTrack) =>
    mergeLocalAudio(localFavoritesById.get(remoteTrack.id), remoteTrack),
  );
  const localById = new Map(
    local.playlists
      .filter(
        (playlist): playlist is PlaylistDocument & { id: string } =>
          playlist.id !== null,
      )
      .map((playlist) => [playlist.id, playlist]),
  );
  for (const remotePlaylist of merged.playlists) {
    if (!remotePlaylist.id) {
      continue;
    }
    const localPlaylist = localById.get(remotePlaylist.id);
    if (!localPlaylist) {
      continue;
    }
    const remoteTracks = remotePlaylist.tracks;
    let remoteIndex = 0;
    remotePlaylist.localId = localPlaylist.localId;
    remotePlaylist.tracks = localPlaylist.tracks.map((localTrack) => {
      if (localTrack.unavailable && !localTrack.itemId) {
        return localTrack;
      }
      const remoteTrack = remoteTracks[remoteIndex];
      remoteIndex += 1;
      if (!remoteTrack) {
        throw new ConflictError(
          `TIDAL playlist ${remotePlaylist.id} is missing an available track after push completion.`,
        );
      }
      return mergeLocalAudio(localTrack, remoteTrack);
    });
    if (remoteIndex !== remoteTracks.length) {
      throw new ConflictError(
        `TIDAL playlist ${remotePlaylist.id} contains unexpected tracks after push completion.`,
      );
    }
  }
  return merged;
}

function mergeLocalAudio(
  localTrack: TrackReference | undefined,
  remoteTrack: TrackReference,
): TrackReference {
  if (!localTrack?.audio) {
    return remoteTrack;
  }
  return {
    ...remoteTrack,
    audio: {
      ...localTrack.audio,
      ...remoteTrack.audio,
    },
  };
}

function operationsAreResumeCompatible(
  current: SyncOperation,
  expected: { index: number; operation: SyncOperation },
  journal: PushJournal,
): boolean {
  const planned = expected.operation;
  const started = journal.startedOperations.includes(expected.index);
  if (
    planned.kind === 'playlist.create' &&
    current.kind === 'playlist.replaceTracks'
  ) {
    return (
      started &&
      journal.createdPlaylistIds[String(expected.index)] ===
        current.playlistId &&
      sameStrings(current.trackIds, planned.trackIds) &&
      isPrefix(
        current.currentTracks.map((track) => track.id),
        planned.trackIds,
      )
    );
  }
  if (current.kind !== planned.kind) {
    return false;
  }

  switch (planned.kind) {
    case 'favorites.add':
    case 'favorites.remove':
      return (
        (current.kind === 'favorites.add' ||
          current.kind === 'favorites.remove') &&
        current.trackIds.every((id) => planned.trackIds.includes(id))
      );
    case 'playlist.create':
      return (
        current.kind === 'playlist.create' &&
        current.localId === planned.localId &&
        current.title === planned.title &&
        current.description === planned.description &&
        sameStrings(current.trackIds, planned.trackIds)
      );
    case 'playlist.delete':
      return (
        current.kind === 'playlist.delete' &&
        current.playlistId === planned.playlistId &&
        current.title === planned.title &&
        current.currentDescription === planned.currentDescription &&
        sameTrackInstances(current.currentTracks, planned.currentTracks)
      );
    case 'playlist.replaceTracks': {
      if (
        current.kind !== 'playlist.replaceTracks' ||
        current.playlistId !== planned.playlistId ||
        !sameStrings(current.trackIds, planned.trackIds)
      ) {
        return false;
      }
      if (!started) {
        return sameTrackInstances(current.currentTracks, planned.currentTracks);
      }
      const currentIds = current.currentTracks.map((track) => track.id);
      return (
        isSuffix(
          currentIds,
          planned.currentTracks.map((track) => track.id),
        ) || isPrefix(currentIds, planned.trackIds)
      );
    }
    case 'playlist.update':
      if (
        current.kind !== 'playlist.update' ||
        current.playlistId !== planned.playlistId ||
        current.title !== planned.title ||
        current.description !== planned.description
      ) {
        return false;
      }
      return (
        (current.currentTitle === planned.currentTitle &&
          current.currentDescription === planned.currentDescription) ||
        (started &&
          current.currentTitle === planned.title &&
          current.currentDescription === planned.description)
      );
  }
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameTrackInstances(
  left: readonly Pick<TrackReference, 'id' | 'itemId'>[],
  right: readonly Pick<TrackReference, 'id' | 'itemId'>[],
): boolean {
  return (
    left.length === right.length &&
    left.every((track, index) => {
      const other = right.at(index);
      return other?.id === track.id && other.itemId === track.itemId;
    })
  );
}

function isPrefix(
  values: readonly string[],
  complete: readonly string[],
): boolean {
  return values.every((value, index) => value === complete[index]);
}

function isSuffix(
  values: readonly string[],
  complete: readonly string[],
): boolean {
  if (values.length > complete.length) {
    return false;
  }
  const offset = complete.length - values.length;
  return values.every((value, index) => value === complete[index + offset]);
}

async function getCompletedRemoteSnapshot(
  client: TidalApiClient,
  local: LibrarySnapshot,
  journal: PushJournal,
): Promise<LibrarySnapshot> {
  let lastConflict: ConflictError | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const remote = await getRemoteSnapshot(client, local.config);
    try {
      assertResumeCompatible(local, remote, journal);
      return remote;
    } catch (error: unknown) {
      if (!(error instanceof ConflictError)) {
        throw error;
      }
      lastConflict = error;
      if (attempt < 2) {
        await delay(250 * (attempt + 1));
      }
    }
  }
  throw (
    lastConflict ??
    new ConflictError('TIDAL did not reach the completed push state.')
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function throwAsPartialApply(error: unknown): never {
  if (error instanceof AuthenticationError || error instanceof ConflictError) {
    throw error;
  }
  const detail = error instanceof Error ? ` Cause: ${error.message}` : '';
  throw new PartialApplyError(
    `The push did not complete. Its journal was preserved; re-run the same push to resume safely.${detail}`,
    { cause: error },
  );
}
