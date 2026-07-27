import { AuthenticationError } from '../errors.js';

export const DEFAULT_TIDAL_SCOPES: readonly string[] = [
  'collection.read',
  'collection.write',
  'entitlements.read',
  'playback',
  'playlists.read',
  'playlists.write',
  'recommendations.read',
  'search.read',
  'search.write',
  'user.read',
];

export type TidalClientConfig = {
  clientId: string;
  clientSecret?: string;
  scopes: string[];
};

export function loadTidalClientConfig(
  environment: NodeJS.ProcessEnv = process.env,
): TidalClientConfig {
  const clientId = environment.TIDAL_CLIENT_ID?.trim();
  const clientSecret = environment.TIDAL_CLIENT_SECRET?.trim();
  const configuredScopes = environment.TIDAL_SCOPES?.split(/[,\s]+/u)
    .map((scope) => scope.trim())
    .filter(Boolean);

  if (!clientId) {
    throw new AuthenticationError(
      'TIDAL_CLIENT_ID is required. Set it to the client ID from your TIDAL developer application.',
    );
  }

  return {
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    scopes:
      configuredScopes && configuredScopes.length > 0
        ? configuredScopes
        : [...DEFAULT_TIDAL_SCOPES],
  };
}
