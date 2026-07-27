import { createAPIClient } from '@tidal-music/api';
import type { CredentialsProvider } from '@tidal-music/common';

import { AuthenticationError, ConflictError, NetworkError } from '../errors.js';

export type CreateTidalClientOptions = {
  credentialsProvider: CredentialsProvider;
  apiBaseUrl?: string;
};

export type TidalApiClient = ReturnType<typeof createAPIClient>;

export function createTidalClient({
  apiBaseUrl,
  credentialsProvider,
}: CreateTidalClientOptions): TidalApiClient {
  return createAPIClient(credentialsProvider, apiBaseUrl);
}

export function throwForTidalError(error: unknown, operation: string): never {
  const tidalError = extractTidalError(error);
  if (tidalError) {
    const status =
      tidalError.status === undefined ? undefined : Number(tidalError.status);
    const detail =
      tidalError.detail ??
      tidalError.title ??
      tidalError.code ??
      'Unknown error';

    if (tidalError.code === 'IDEMPOTENT_REQUEST_IN_PROGRESS') {
      throw new NetworkError(`${operation} is still processing: ${detail}`);
    }
    if (
      status === 401 ||
      status === 403 ||
      tidalError.code === 'UNAUTHORIZED'
    ) {
      throw new AuthenticationError(`${operation} failed: ${detail}`);
    }
    if (status === 409 || status === 412 || status === 422) {
      throw new ConflictError(`${operation} failed: ${detail}`);
    }
    const statusDescription = Number.isFinite(status)
      ? ` with HTTP ${status}`
      : '';
    throw new NetworkError(
      `${operation} failed${statusDescription}: ${detail}`,
    );
  }

  if (error instanceof Error) {
    throw new NetworkError(`${operation} failed: ${error.message}`, {
      cause: error,
    });
  }

  throw new NetworkError(`${operation} failed.`);
}

export async function executeTidalRequest<T extends TidalApiResponse>(
  operation: string,
  request: () => Promise<T>,
): Promise<T> {
  try {
    const response = await request();
    if (!response.response.ok) {
      throwForTidalError(
        response.error ?? {
          status: response.response.status,
          title: response.response.statusText || undefined,
        },
        operation,
      );
    }
    return response;
  } catch (error: unknown) {
    throwForTidalError(error, operation);
  }
}

type TidalApiResponse = {
  error?: unknown;
  response: Response;
};

type TidalError = {
  code?: string;
  detail?: string;
  status?: number | string;
  title?: string;
};

function extractTidalError(value: unknown): TidalError | undefined {
  if (
    typeof value === 'object' &&
    value !== null &&
    'errors' in value &&
    Array.isArray(value.errors)
  ) {
    return value.errors.find(isTidalError);
  }
  return isTidalError(value) ? value : undefined;
}

function isTidalError(value: unknown): value is TidalError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (('status' in value &&
      (typeof value.status === 'number' || typeof value.status === 'string')) ||
      ('code' in value && typeof value.code === 'string') ||
      ('detail' in value && typeof value.detail === 'string') ||
      ('title' in value && typeof value.title === 'string'))
  );
}
