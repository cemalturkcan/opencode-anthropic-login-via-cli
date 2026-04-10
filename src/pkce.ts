import { randomBytes, createHash } from "node:crypto";
import {
  CLIENT_ID,
  AUTHORIZE_URL,
  TOKEN_URL,
  REDIRECT_URI,
  type OAuthTokens,
} from "./constants.ts";
import { log } from "./logger.ts";
import { fetchWithRetry } from "./http.ts";

function base64url(buf: Buffer): string {
  return buf.toString("base64url").replace(/=+$/, "");
}

export function createAuthorizationRequest(scopes: string) {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const params = new URLSearchParams({
    code: "true",
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: scopes,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });
  return { url: `${AUTHORIZE_URL}?${params}`, verifier };
}

/**
 * Parse an OAuth callback input that may arrive in several formats:
 *
 *  1. Full callback URL  — https://platform.claude.com/oauth/code/callback?code=ABC&state=XYZ
 *  2. Query string        — code=ABC&state=XYZ
 *  3. Hash-separated      — ABC#XYZ   (legacy format)
 *  4. Plain code          — ABC
 *
 * Returns only the authorization code portion, trimmed.
 */
export function parseCallbackCode(raw: string): string {
  const trimmed = raw.trim();

  let isUrl = false;
  try {
    const url = new URL(trimmed);
    isUrl = true;
    const error = url.searchParams.get("error");
    if (error) throw new Error(`OAuth error: ${error}`);
    const code = url.searchParams.get("code");
    if (code !== null) return code;
    throw new Error("OAuth callback URL is missing a code parameter");
  } catch (e) {
    if (isUrl) throw e;
  }

  if (trimmed.includes("=")) {
    const defragmented = trimmed.split("#")[0];
    const params = new URLSearchParams(defragmented);
    const code = params.get("code");
    if (code !== null) return code;
  }

  const hashIdx = trimmed.indexOf("#");
  if (hashIdx >= 0) return trimmed.slice(0, hashIdx);

  return trimmed;
}

export async function exchangeCodeForTokens(
  rawCode: string,
  verifier: string,
  userAgent: string,
): Promise<OAuthTokens> {
  const code = parseCallbackCode(rawCode);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state: verifier,
  });

  log.info("Exchanging authorization code for tokens");

  const res = await fetchWithRetry(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Token exchange failed: ${res.status} ${res.statusText}${text ? ` — ${text}` : ""}`,
    );
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  log.info("Token exchange successful");

  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
  };
}
