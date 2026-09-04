/**
 * Authorization Code with PKCE (RFC 7636) for Spotify.
 *
 * Pure and I/O-free: randomness is injected, and hashing goes through the
 * platform's Web Crypto. The network side lives in apps/server.
 *
 * Spike P1-01 established two constraints that shape this module:
 *
 *  1. Spotify's Device Authorization Grant (RFC 8628) exists but is allowlisted
 *     to Spotify's own TV applications — it does not work for a client_id
 *     registered through the Developer Dashboard. The appliance-shaped flow is
 *     therefore closed to us, and PKCE + loopback is the answer.
 *
 *  2. Since 27 November 2025 a redirect URI must be HTTPS, *or* an HTTP
 *     loopback literal. `localhost` is rejected outright. `assertRedirectUri`
 *     encodes that rule so a bad value fails here rather than at Spotify.
 */

/** The unreserved character set RFC 7636 permits in a code verifier. */
const VERIFIER_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

/** RFC 7636 §4.1 bounds. */
export const VERIFIER_MIN_LENGTH = 43;
export const VERIFIER_MAX_LENGTH = 128;

export type RandomBytes = (byteLength: number) => Uint8Array;

const webcryptoRandomBytes: RandomBytes = (byteLength) =>
  crypto.getRandomValues(new Uint8Array(byteLength));

const base64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/**
 * A high-entropy random string, per RFC 7636 §4.1.
 *
 * The alphabet is 64 characters and a byte has 256 values, so `byte % 64` is
 * an exact partition — no modulo bias to correct for.
 */
export const createVerifier = (
  length = 64,
  randomBytes: RandomBytes = webcryptoRandomBytes,
): string => {
  if (length < VERIFIER_MIN_LENGTH || length > VERIFIER_MAX_LENGTH) {
    throw new RangeError(
      `code verifier must be ${String(VERIFIER_MIN_LENGTH)}-${String(
        VERIFIER_MAX_LENGTH,
      )} characters, got ${String(length)}`,
    );
  }
  let verifier = '';
  for (const byte of randomBytes(length)) {
    verifier += VERIFIER_ALPHABET[byte % VERIFIER_ALPHABET.length] ?? '';
  }
  return verifier;
};

/** An opaque value round-tripped through the authorize request to defeat CSRF. */
export const createState = (randomBytes: RandomBytes = webcryptoRandomBytes): string =>
  base64Url(randomBytes(32));

/** `BASE64URL(SHA256(verifier))` — the S256 challenge method. */
export const challengeFor = async (verifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(digest));
};

export interface RedirectUriProblem {
  readonly uri: string;
  readonly reason: string;
}

/**
 * Spotify's redirect URI rules, enforced locally.
 *
 * Returns a problem describing why the URI would be rejected, or `undefined`
 * if it is acceptable.
 */
export const checkRedirectUri = (uri: string): RedirectUriProblem | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return { uri, reason: 'not a valid absolute URI' };
  }

  if (parsed.protocol === 'https:') return undefined;

  if (parsed.protocol !== 'http:') {
    return { uri, reason: `scheme "${parsed.protocol}" is not https or http` };
  }

  // http is permitted only for loopback literals.
  if (parsed.hostname === 'localhost') {
    return {
      uri,
      reason:
        'Spotify rejects the "localhost" hostname; use the literal 127.0.0.1 or [::1]',
    };
  }
  if (parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]') {
    return undefined;
  }
  return {
    uri,
    reason: `http is only allowed for loopback literals, not "${parsed.hostname}"`,
  };
};

export interface AuthorizeRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly state: string;
  readonly codeChallenge: string;
  /** Overridable so tests and spikes can point at a fake Spotify. */
  readonly authorizeEndpoint?: string;
}

export const SPOTIFY_AUTHORIZE_ENDPOINT = 'https://accounts.spotify.com/authorize';

/** Build the URL the user's browser must visit to grant access. */
export const buildAuthorizeUrl = (request: AuthorizeRequest): string => {
  const problem = checkRedirectUri(request.redirectUri);
  if (problem) {
    throw new Error(`invalid redirect URI: ${problem.reason}`);
  }
  const url = new URL(request.authorizeEndpoint ?? SPOTIFY_AUTHORIZE_ENDPOINT);
  url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', request.redirectUri);
  url.searchParams.set('scope', request.scopes.join(' '));
  url.searchParams.set('state', request.state);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('code_challenge', request.codeChallenge);
  return url.toString();
};
