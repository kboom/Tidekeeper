import type { LibrarySnapshot, TidekeeperConfig } from '../domain.js';
import type { TidalApiClient } from './client.js';
import { getFavoriteTracks } from './favorites.js';
import { getOwnedPlaylists } from './playlists.js';

export async function getRemoteSnapshot(
  client: TidalApiClient,
  config: TidekeeperConfig,
): Promise<LibrarySnapshot> {
  const favorites = await getFavoriteTracks(client, config.countryCode);
  const playlists = await getOwnedPlaylists(client, config.countryCode);
  return { config, favorites, playlists };
}
