import type { OutputFormatValue, OutputStreams } from '../output.js';
import { writeOutput } from '../output.js';
import type { PullResult, PushOptions, PushResult } from '../sync/service.js';
import type { SyncOperation, SyncPlan } from '../sync/plan.js';

export type SyncHandlers = {
  plan(root: string): Promise<SyncPlan>;
  pull(root: string, apply: boolean, force: boolean): Promise<PullResult>;
  push(root: string, options: PushOptions): Promise<PushResult>;
};

export function writePullResult(
  result: PullResult,
  output: OutputFormatValue,
  streams: OutputStreams,
): void {
  writeOutput(streams.stdout, output, result, [
    {
      applied: result.applied,
      changed: result.changed,
      remoteFingerprint: result.remoteFingerprint,
    },
  ]);
}

export function writeSyncPlan(
  plan: SyncPlan,
  output: OutputFormatValue,
  streams: OutputStreams,
): void {
  writeOutput(
    streams.stdout,
    output,
    plan,
    plan.operations.map((operation, index) => operationRow(operation, index)),
  );
}

export function writePushResult(
  result: PushResult,
  output: OutputFormatValue,
  streams: OutputStreams,
): void {
  writeOutput(streams.stdout, output, result, [
    {
      appliedOperations: result.appliedOperations,
      digest: result.plan.digest,
      hasRemovals: result.plan.hasRemovals,
    },
  ]);
}

function operationRow(
  operation: SyncOperation,
  index: number,
): Record<string, string | number | boolean | null> {
  switch (operation.kind) {
    case 'favorites.add':
    case 'favorites.remove':
      return {
        count: operation.trackIds.length,
        index,
        operation: operation.kind,
        target: 'favorites',
      };
    case 'playlist.create':
      return {
        count: operation.trackIds.length,
        index,
        operation: operation.kind,
        target: operation.title,
      };
    case 'playlist.delete':
    case 'playlist.update':
      return {
        count: 1,
        index,
        operation: operation.kind,
        target: operation.title,
      };
    case 'playlist.replaceTracks':
      return {
        count: operation.trackIds.length,
        index,
        operation: operation.kind,
        target: operation.title,
      };
  }
}
