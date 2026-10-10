import { createHash, randomBytes } from "node:crypto";
import {
  authorizeUrl,
  oauthClientId,
  redirectUri,
  tokenUrl,
  type OAuthTokens,
} from "./constants.ts";
import { fetchWithRetry } from "./http.ts";
import { getIntro } from "./introspection.ts";
import { isJsonNumber, isJsonObject, isJsonString, type JsonValue } from "./json.ts";
import { log } from "./logger.ts";

export type AuthorizationRequest = { url: string; verifier: string };

const refreshesInFlight = new Map<string, Promise<OAuthTokens>>();

function base64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export function createAuthorizationRequest(scopes: string): AuthorizationRequest {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const params = new URLSearchParams({
    code: "true",
    response_type: "code",
    client_id: oauthClientId,
    redirect_uri: redirectUri,
    scope: scopes,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });
  return { url: `${authorizeUrl}?${params}`, verifier };
}

function codeFromCallbackUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  const error = url.searchParams.get("error");
  if (error) throw new Error(`OAuth error: ${error}`);
  const code = url.searchParams.get("code");
  if (code === null) throw new Error("OAuth callback URL is missing a code parameter");
  return code;
}

export function parseCallbackCode(raw: string): string {
  const trimmed = raw.trim();

  const urlCode = codeFromCallbackUrl(trimmed);
  if (urlCode !== null) return urlCode;

  if (trimmed.includes("=")) {
    const queryCode = new URLSearchParams(trimmed.split("#")[0]).get("code");
    if (queryCode !== null) return queryCode;
  }

  const hashIndex = trimmed.indexOf("#");
  return hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
}

function describeFailure(response: Response, body: string): string {
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  const detail = body ? `: ${body}` : "";
  return `${response.status}${statusText}${detail}`;
}

async function postTokenRequest(
  params: Record<string, string>,
  userAgent: string,
  failurePrefix: string,
): Promise<OAuthTokens> {
  const response = await fetchWithRetry(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
    },
    body: new URLSearchParams({ ...params, client_id: oauthClientId }).toString(),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${failurePrefix}: ${describeFailure(response, body)}`);
  }

  const body: JsonValue = await response.json();
  if (
    !isJsonObject(body) ||
    !isJsonString(body.access_token) ||
    !isJsonString(body.refresh_token) ||
    !isJsonNumber(body.expires_in)
  ) {
    throw new Error(`${failurePrefix}: unexpected token response`);
  }
  return {
    access: body.access_token,
    refresh: body.refresh_token,
    expires: Date.now() + body.expires_in * 1000,
  };
}

export async function exchangeCodeForTokens(
  rawCode: string,
  verifier: string,
  userAgent: string,
): Promise<OAuthTokens> {
  log.info("exchanging authorization code for tokens");
  const tokens = await postTokenRequest(
    {
      grant_type: "authorization_code",
      code: parseCallbackCode(rawCode),
      code_verifier: verifier,
      redirect_uri: redirectUri,
      state: verifier,
    },
    userAgent,
    "Token exchange failed",
  );
  log.info("token exchange succeeded");
  return tokens;
}

async function refreshTokens(refreshToken: string): Promise<OAuthTokens> {
  log.info("refreshing oauth token");
  try {
    const tokens = await postTokenRequest(
      { grant_type: "refresh_token", refresh_token: refreshToken },
      getIntro().userAgent,
      "Token refresh failed",
    );
    log.info("token refresh succeeded");
    return tokens;
  } catch (failure) {
    log.error("token refresh failed", { error: String(failure) });
    throw failure;
  }
}

export function refreshTokensOnce(refreshToken: string): Promise<OAuthTokens> {
  const inFlight = refreshesInFlight.get(refreshToken);
  if (inFlight) return inFlight;

  const refresh = refreshTokens(refreshToken).finally(() => refreshesInFlight.delete(refreshToken));
  refreshesInFlight.set(refreshToken, refresh);
  return refresh;
}

export function createCodeExchange(verifier: string): (code: string) => Promise<OAuthTokens> {
  let pending: Promise<OAuthTokens> | null = null;
  return (code) => {
    pending ??= exchangeCodeForTokens(code, verifier, getIntro().userAgent).catch((failure) => {
      pending = null;
      log.error("token exchange failed", { error: String(failure) });
      throw failure;
    });
    return pending;
  };
}
