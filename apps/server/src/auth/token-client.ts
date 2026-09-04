/**
 * The HTTP half of the token lifecycle. Parsing and scheduling live in
 * @joshify/core; this module only talks to the network and hands the body over.
 */
import {
  classifyHttpFailure,
  classifyThrown,
  err,
  ok,
  parseTokenResponse,
  type JoshifyError,
  type Result,
  type TokenSet,
} from '@joshify/core';

export const SPOTIFY_TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';

export interface TokenClientConfig {
  readonly clientId: string;
  /** Overridable so tests can point at the fake Spotify. */
  readonly tokenEndpoint?: string;
  readonly fetchImpl?: typeof fetch;
  /** Epoch ms. Injected so token expiry is deterministic in tests. */
  readonly now?: () => number;
}

export interface ExchangeCodeRequest {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

export interface RefreshRequest {
  readonly refreshToken: string;
}

const post = async (
  config: TokenClientConfig,
  form: Record<string, string>,
): Promise<Result<unknown, JoshifyError>> => {
  const doFetch = config.fetchImpl ?? fetch;
  const endpoint = config.tokenEndpoint ?? SPOTIFY_TOKEN_ENDPOINT;

  let response: Response;
  try {
    response = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
  } catch (cause) {
    return err(classifyThrown(cause));
  }

  // A non-JSON body is itself a signal something is wrong; don't let a parse
  // failure mask the status we actually care about.
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    return err(
      classifyHttpFailure({
        status: response.status,
        body,
        retryAfter: response.headers.get('retry-after'),
      }),
    );
  }
  return ok(body);
};

/** Trade an authorization code for tokens, proving possession of the verifier. */
export const exchangeCode = async (
  config: TokenClientConfig,
  request: ExchangeCodeRequest,
): Promise<Result<TokenSet, JoshifyError>> => {
  const response = await post(config, {
    grant_type: 'authorization_code',
    code: request.code,
    redirect_uri: request.redirectUri,
    client_id: config.clientId,
    code_verifier: request.codeVerifier,
  });
  if (!response.ok) return response;
  return parseTokenResponse(response.value, { now: (config.now ?? Date.now)() });
};

/**
 * Exchange a refresh token for a fresh access token.
 *
 * The presented refresh token is passed through as `previousRefreshToken` so
 * that a response omitting `refresh_token` — which Spotify commonly sends —
 * keeps the one we already hold rather than losing it.
 */
export const refreshTokens = async (
  config: TokenClientConfig,
  request: RefreshRequest,
): Promise<Result<TokenSet, JoshifyError>> => {
  const response = await post(config, {
    grant_type: 'refresh_token',
    refresh_token: request.refreshToken,
    client_id: config.clientId,
  });
  if (!response.ok) return response;
  return parseTokenResponse(response.value, {
    now: (config.now ?? Date.now)(),
    previousRefreshToken: request.refreshToken,
  });
};
