import { getInitializedCredentialsProvider } from '../auth/service.js';
import { createTidalClient, type TidalApiClient } from './client.js';

export async function createAuthenticatedTidalClient(): Promise<TidalApiClient> {
  const credentialsProvider = await getInitializedCredentialsProvider();
  return createTidalClient({ credentialsProvider });
}
