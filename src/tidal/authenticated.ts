import { getInitializedCredentialsProvider } from '../auth/service.js';
import type { StorageAdapter } from '@tidal-music/auth';
import { createTidalClient, type TidalApiClient } from './client.js';

export async function createAuthenticatedTidalClient(
  storage?: StorageAdapter,
): Promise<TidalApiClient> {
  const credentialsProvider = await getInitializedCredentialsProvider(storage);
  return createTidalClient({ credentialsProvider });
}
