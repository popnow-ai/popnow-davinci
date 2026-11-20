import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { AccountSession } from "./store.js";

/**
 * Sign-in with a PopNow account inside DaVinci Resolve: OAuth 2.1 authorization code with PKCE, a
 * dynamically registered public client and a loopback redirect on 127.0.0.1 (RFC 8252), the same
 * flow MCP clients use against https://api.popnow.ai/mcp. Ported from popnow-cli src/account/oauth.ts.
 */

export const DEFAULT_MCP_URL = "https://api.popnow.ai/mcp";
export const SCOPES = "generate read";
const CLIENT_NAME = "PopNow for DaVinci Resolve";
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface AuthServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  revocationEndpoint?: string;
}

type Fetch = typeof fetch;

async function getJson(fetchImpl: Fetch, url: string): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`the sign-in server did not return ${what}`);
  return value;
}

function isLoopback(url: URL): boolean {
  return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

/** Only https, except a server on this computer (for local testing). */
export function requireSecure(raw: string, what: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) {
    throw new Error(`${what} must use https: ${url.origin}`);
  }
  return url;
}

/** Finds the authorization server from the MCP endpoint's protected-resource metadata (RFC 9728). */
export async function discover(fetchImpl: Fetch, mcpUrl: string): Promise<AuthServer> {
  const mcp = requireSecure(mcpUrl, "the PopNow server");
  const resourceMeta = await getJson(
    fetchImpl,
    `${mcp.origin}/.well-known/oauth-protected-resource${mcp.pathname === "/" ? "" : mcp.pathname}`,
  );
  const servers = resourceMeta.authorization_servers;
  const issuer = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] : mcp.origin;
  requireSecure(issuer, "the sign-in server");
  const meta = await getJson(fetchImpl, `${issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`);
  const revocation = meta.revocation_endpoint;
  const declared = str(meta.issuer, "an issuer");
  if (declared.replace(/\/$/, "") !== issuer.replace(/\/$/, "")) {
    throw new Error("the sign-in server's metadata does not match it (issuer mismatch)");
  }
  for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
    requireSecure(str(meta[key], key.replace(/_/g, " ")), "the sign-in server");
  }
  if (typeof revocation === "string") requireSecure(revocation, "the sign-in server");
  return {
    issuer: declared,
    authorizationEndpoint: str(meta.authorization_endpoint, "an authorization endpoint"),
    tokenEndpoint: str(meta.token_endpoint, "a token endpoint"),
    registrationEndpoint: str(meta.registration_endpoint, "a registration endpoint"),
    ...(typeof revocation === "string" ? { revocationEndpoint: revocation } : {}),
  };
}

export async function registerClient(
  fetchImpl: Fetch,
  server: AuthServer,
  redirectUri: string,
  clientName: string = CLIENT_NAME,
): Promise<string> {
  const response = await fetchImpl(server.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPES,
    }),
  });
  if (!response.ok) throw new Error(`client registration failed (${response.status})`);
  return str(((await response.json()) as Record<string, unknown>).client_id, "a client id");
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export interface Loopback {
  redirectUri: string;
  /**
   * Resolves with the authorization code once the browser comes back with the right state (and issuer,
   * when the server sends one). Replies that don't match get a 400 and the wait goes on.
   */
  code: (state: string, issuer: string, timeoutMs?: number) => Promise<string>;
  /** Stops waiting: the pending code() rejects with "Sign-in was canceled." */
  cancel: () => void;
  close: () => void;
}

const DONE_PAGE = (ok: boolean, text: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PopNow</title>` +
  `<style>body{font:16px/1.5 system-ui,sans-serif;background:#FAF4E8;color:#352242;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:28rem;padding:24px;text-align:center}h1{font-size:22px;margin:0 0 8px}</style></head>` +
  `<body><main><h1>${ok ? "Signed in to PopNow" : "Sign-in did not finish"}</h1><p>${text}</p></main></body></html>`;

/** A one-shot HTTP listener on 127.0.0.1 with a random port, for the OAuth redirect. */
export async function startLoopback(): Promise<Loopback> {
  let expected: { state: string; issuer: string } | undefined;
  let settle: { resolve: (code: string) => void; reject: (error: Error) => void } | undefined;
  let done = false;
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const page = (status: number, ok: boolean, text: string): void => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(DONE_PAGE(ok, text));
    };
    if (url.pathname !== "/callback" || !expected || done) {
      response.writeHead(404).end();
      return;
    }
    const params = url.searchParams;
    if (params.get("state") !== expected.state) {
      page(400, false, "This sign-in link is not the one DaVinci Resolve is waiting for.");
      return;
    }
    const iss = params.get("iss");
    if (iss !== null && iss.replace(/\/$/, "") !== expected.issuer.replace(/\/$/, "")) {
      page(400, false, "The reply came from an unexpected server.");
      return;
    }
    const error = params.get("error");
    const code = params.get("code");
    done = true;
    if (error || !code) {
      page(400, false, "Go back to DaVinci Resolve and sign in again.");
      settle?.reject(new Error(error === "access_denied" ? "Sign-in was canceled." : `sign-in failed: ${error ?? "no code in the reply"}`));
      return;
    }
    page(200, true, "You can close this tab and go back to DaVinci Resolve.");
    settle?.resolve(code);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    code: (state, issuer, timeoutMs = LOGIN_TIMEOUT_MS) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          done = true;
          reject(new Error("Sign-in timed out. Try again."));
        }, timeoutMs);
        timer.unref?.();
        expected = { state, issuer };
        settle = {
          resolve: (code) => {
            clearTimeout(timer);
            resolve(code);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
      }),
    cancel: () => {
      done = true;
      settle?.reject(new Error("Sign-in was canceled."));
    },
    close: () => {
      server.closeAllConnections?.();
      server.close();
    },
  };
}

export function authorizeUrl(
  server: AuthServer,
  options: { clientId: string; redirectUri: string; state: string; challenge: string; resource: string },
): string {
  const url = new URL(server.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", options.resource);
  return url.toString();
}

interface TokenReply {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

async function tokenRequest(fetchImpl: Fetch, endpoint: string, form: Record<string, string>): Promise<TokenReply> {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const reply = (await response.json().catch(() => ({}))) as TokenReply;
  if (!response.ok || typeof reply.access_token !== "string") {
    const reason = typeof reply.error === "string" ? reply.error : String(response.status);
    const error = new Error(`the sign-in server refused the request (${reason})`);
    (error as Error & { oauthError?: string }).oauthError = reason;
    throw error;
  }
  return reply;
}

function sessionFrom(reply: TokenReply, base: Omit<AccountSession, "accessToken">, now: number): AccountSession {
  const expiresIn = typeof reply.expires_in === "number" ? reply.expires_in : undefined;
  return {
    ...base,
    accessToken: reply.access_token as string,
    ...(typeof reply.refresh_token === "string"
      ? { refreshToken: reply.refresh_token }
      : base.refreshToken === undefined
        ? {}
        : { refreshToken: base.refreshToken }),
    ...(expiresIn === undefined ? {} : { expiresAt: now + expiresIn * 1000 }),
    ...(typeof reply.scope === "string" ? { scope: reply.scope } : {}),
  };
}

export interface LoginOptions {
  fetch: Fetch;
  mcpUrl: string;
  /** Opens the sign-in link in a browser; returns false when nothing could be opened. */
  openUrl: (url: string) => Promise<boolean>;
  /** Prints the sign-in link so it can be opened by hand. */
  showUrl: (url: string) => void;
  noBrowser?: boolean;
  now?: () => number;
  timeoutMs?: number;
  /** Aborts the wait for the browser (the user pressed Cancel). */
  signal?: AbortSignal;
}

export async function login(options: LoginOptions): Promise<AccountSession> {
  const server = await discover(options.fetch, options.mcpUrl);
  const loopback = await startLoopback();
  try {
    const clientId = await registerClient(options.fetch, server, loopback.redirectUri);
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(16).toString("base64url");
    const url = authorizeUrl(server, {
      clientId,
      redirectUri: loopback.redirectUri,
      state,
      challenge,
      resource: options.mcpUrl,
    });
    const waiting = loopback.code(state, server.issuer, options.timeoutMs);
    if (options.signal) {
      const abort = (): void => loopback.cancel();
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    }
    // A reply can arrive (and fail) before we await it below; keep that from becoming an unhandled rejection.
    waiting.catch(() => undefined);
    // Always show the link: it is the way back when the browser opened the wrong profile or did not open at all.
    options.showUrl(url);
    if (!options.noBrowser) await options.openUrl(url);
    const code = await waiting;
    const reply = await tokenRequest(options.fetch, server.tokenEndpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: loopback.redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: options.mcpUrl,
    });
    return sessionFrom(
      reply,
      {
        issuer: server.issuer,
        mcpUrl: options.mcpUrl,
        tokenEndpoint: server.tokenEndpoint,
        ...(server.revocationEndpoint === undefined ? {} : { revocationEndpoint: server.revocationEndpoint }),
        clientId,
      },
      (options.now ?? Date.now)(),
    );
  } finally {
    loopback.close();
  }
}

/** Uses the refresh token; throws when there is none or the server refuses it. */
export async function refresh(fetchImpl: Fetch, session: AccountSession, now: number = Date.now()): Promise<AccountSession> {
  if (!session.refreshToken) throw new Error("Your PopNow sign-in expired. Sign in again.");
  const reply = await tokenRequest(fetchImpl, session.tokenEndpoint, {
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
    client_id: session.clientId,
    resource: session.mcpUrl,
  });
  const { accessToken: _old, ...base } = session;
  return sessionFrom(reply, base, now);
}

/** Best effort: a failed revocation never blocks signing out locally. */
export async function revoke(fetchImpl: Fetch, session: AccountSession): Promise<boolean> {
  if (!session.revocationEndpoint) return false;
  let ok = true;
  for (const [token, hint] of [
    [session.refreshToken, "refresh_token"],
    [session.accessToken, "access_token"],
  ] as const) {
    if (!token) continue;
    try {
      const response = await fetchImpl(session.revocationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token, token_type_hint: hint, client_id: session.clientId }).toString(),
      });
      ok &&= response.ok;
    } catch {
      ok = false;
    }
  }
  return ok;
}
