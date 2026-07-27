import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  credentialsProvider,
  finalizeLogin,
  init,
  initializeLogin,
  logout,
  type StorageAdapter,
} from '@tidal-music/auth';
import open from 'open';
import { z } from 'zod';

import { AuthenticationError, ValidationError } from '../errors.js';
import { loadTidalClientConfig } from './config.js';
import { KeyringStorageAdapter } from './storage.js';

const CREDENTIALS_STORAGE_KEY = 'tidal-user-session';
const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:53682/callback';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;
const persistedCredentialsSchema = z
  .object({
    accessToken: z
      .object({
        expires: z.number().optional(),
        grantedScopes: z.array(z.string()).optional(),
        token: z.string().optional(),
        userId: z.string().optional(),
      })
      .loose()
      .optional(),
    refreshToken: z.string().optional(),
  })
  .loose();

export type AuthStatus = {
  authenticated: boolean;
  expiresAt?: string;
  grantedScopes: string[];
  userId?: string;
};

export type LoginOptions = {
  redirectUri?: string;
};

export async function initializeAuth(
  storage: StorageAdapter = new KeyringStorageAdapter(),
): Promise<StorageAdapter> {
  const config = loadTidalClientConfig();
  await init({
    clientId: config.clientId,
    ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
    credentialsStorageKey: CREDENTIALS_STORAGE_KEY,
    scopes: config.scopes,
    storage,
  });
  return storage;
}

export async function login(options: LoginOptions = {}): Promise<AuthStatus> {
  await initializeAuth();
  const redirectUri = validateRedirectUri(
    options.redirectUri ??
      process.env.TIDAL_REDIRECT_URI ??
      DEFAULT_REDIRECT_URI,
  );
  const state = randomBytes(32).toString('hex');
  const callback = createCallbackListener(redirectUri, state);

  try {
    const loginUrl = await initializeLogin({
      redirectUri: redirectUri.toString(),
      loginConfig: { state },
    });
    await callback.ready;
    await open(loginUrl);
    const callbackUrl = await callback.result;
    await finalizeLogin(callbackUrl.search);
    return await getAuthStatus();
  } finally {
    await closeServer(callback.server);
  }
}

export async function getAuthStatus(): Promise<AuthStatus> {
  const storage = await initializeAuth();
  const persisted = await storage.load(CREDENTIALS_STORAGE_KEY);
  if (!persisted) {
    return { authenticated: false, grantedScopes: [] };
  }

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(persisted);
  } catch (error: unknown) {
    throw new AuthenticationError(
      'The stored TIDAL session is invalid. Run "tidekeeper auth logout" and log in again.',
      { cause: error },
    );
  }
  const parsed = persistedCredentialsSchema.safeParse(parsedValue);
  if (!parsed.success || !parsed.data.accessToken?.userId) {
    return { authenticated: false, grantedScopes: [] };
  }

  let credentials;
  try {
    credentials = await credentialsProvider.getCredentials();
  } catch (error: unknown) {
    throw new AuthenticationError(
      'Unable to refresh the stored TIDAL session. Log in again.',
      { cause: error },
    );
  }
  return {
    authenticated: Boolean(credentials.token && credentials.userId),
    ...(credentials.expires
      ? { expiresAt: new Date(credentials.expires).toISOString() }
      : {}),
    grantedScopes: credentials.grantedScopes ?? [],
    ...(credentials.userId ? { userId: credentials.userId } : {}),
  };
}

export async function logoutUser(): Promise<void> {
  const storage = await initializeAuth();
  logout();
  await storage.remove(CREDENTIALS_STORAGE_KEY);
}

export async function getInitializedCredentialsProvider() {
  await initializeAuth();
  return credentialsProvider;
}

type CallbackListener = {
  ready: Promise<void>;
  result: Promise<URL>;
  server: Server;
};

function createCallbackListener(
  redirectUri: URL,
  expectedState: string,
): CallbackListener {
  let resolveResult = (url: URL): void => {
    void url;
    throw new Error('OAuth callback listener was not initialized.');
  };
  let rejectResult = (error: Error): void => {
    void error;
    throw new Error('OAuth callback listener was not initialized.');
  };
  const result = new Promise<URL>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const server = createServer((request, response) => {
    const requestUrl = new URL(
      request.url ?? '/',
      `${redirectUri.protocol}//${redirectUri.host}`,
    );
    if (requestUrl.pathname !== redirectUri.pathname) {
      response.writeHead(404).end('Not found');
      return;
    }

    const state = requestUrl.searchParams.get('state');
    if (!state || !statesMatch(state, expectedState)) {
      response.writeHead(400).end('Invalid OAuth state');
      rejectResult(
        new AuthenticationError('TIDAL login returned an invalid OAuth state.'),
      );
      return;
    }

    const oauthError = requestUrl.searchParams.get('error');
    if (oauthError) {
      response.writeHead(400).end('TIDAL authorization failed');
      rejectResult(
        new AuthenticationError(
          `TIDAL authorization failed: ${
            requestUrl.searchParams.get('error_description') ?? oauthError
          }`,
        ),
      );
      return;
    }

    response
      .writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end('Tidekeeper is authenticated. You can close this window.');
    resolveResult(requestUrl);
  });

  const port = Number(redirectUri.port);
  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, redirectUri.hostname, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const timeout = setTimeout(() => {
    rejectResult(
      new AuthenticationError('TIDAL login timed out after 5 minutes.'),
    );
  }, LOGIN_TIMEOUT_MS);
  timeout.unref();
  void result.then(
    () => clearTimeout(timeout),
    () => clearTimeout(timeout),
  );

  return { ready, result, server };
}

function validateRedirectUri(value: string): URL {
  const redirectUri = new URL(value);
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (
    redirectUri.protocol !== 'http:' ||
    !loopbackHosts.has(redirectUri.hostname) ||
    !redirectUri.port ||
    redirectUri.search ||
    redirectUri.hash
  ) {
    throw new ValidationError(
      'The TIDAL redirect URI must be an HTTP loopback URL with an explicit port and no query or fragment.',
    );
  }
  return redirectUri;
}

function statesMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
