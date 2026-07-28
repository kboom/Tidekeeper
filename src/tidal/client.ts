import { createAPIClient } from '@tidal-music/api';
import type { CredentialsProvider } from '@tidal-music/common';
import { setTimeout as delay } from 'node:timers/promises';

import { AuthenticationError, ConflictError, NetworkError } from '../errors.js';

const maxRateLimitAttempts = 6;
const maxRetryDelayMs = 60_000;

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
  for (let attempt = 0; ; attempt += 1) {
    let response: T;
    try {
      response = await request();
    } catch (error: unknown) {
      if (
        error instanceof AuthenticationError ||
        error instanceof ConflictError ||
        error instanceof NetworkError
      ) {
        throw error;
      }
      throwForTidalError(error, operation);
    }
    if (
      response.response.status === 429 &&
      attempt < maxRateLimitAttempts - 1
    ) {
      await delay(rateLimitDelayMs(response.response, attempt));
      continue;
    }
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

function rateLimitDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('Retry-After');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, maxRetryDelayMs);
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      return Math.min(Math.max(date - Date.now(), 0), maxRetryDelayMs);
    }
  }
  return Math.min(2 ** attempt * 1_000, maxRetryDelayMs);
}
