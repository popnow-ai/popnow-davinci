import { refresh } from "./oauth.js";
import type { AccountSession } from "./store.js";

/**
 * A small Streamable HTTP MCP client for the PopNow account server (https://api.popnow.ai/mcp).
 * Ported from popnow-cli src/account/mcp.ts; adds cancel signals for long calls.
 */

const PROTOCOL_VERSION = "2025-06-18";

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  resource?: { uri?: string; text?: string; mimeType?: string };
}

export interface McpToolResult {
  content?: McpContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export class AccountSignInRequiredError extends Error {
  constructor(message = "Sign in to PopNow first.") {
    super(message);
    this.name = "AccountSignInRequiredError";
  }
}

type Fetch = typeof fetch;

/** Reads a JSON-RPC reply that came back either as JSON or as a server-sent event stream. */
async function readReply(response: Response, id: number): Promise<Record<string, unknown>> {
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  const messages: unknown[] = [];
  if (type.includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) messages.push(JSON.parse(data));
    }
  } else if (text.trim()) {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) messages.push(...parsed);
    else messages.push(parsed);
  }
  const reply = messages.find(
    (message): message is Record<string, unknown> =>
      message !== null && typeof message === "object" && (message as Record<string, unknown>).id === id,
  );
  if (!reply) throw new Error("the PopNow server sent no reply");
  const error = reply.error as { message?: string } | undefined;
  if (error) throw new Error(error.message ?? "the PopNow server returned an error");
  return (reply.result ?? {}) as Record<string, unknown>;
}

export interface AccountClientOptions {
  fetch: Fetch;
  session: AccountSession;
  /** Called with a refreshed session so the caller can save it. */
  onSession: (session: AccountSession) => Promise<void>;
  clientVersion: string;
  /** clientInfo.name sent on initialize. */
  clientName?: string;
  now?: () => number;
}

export class AccountClient {
  private session: AccountSession;
  private sessionId: string | undefined;
  private protocolVersion = PROTOCOL_VERSION;
  private initialized = false;
  private nextId = 1;

  constructor(private readonly options: AccountClientOptions) {
    this.session = options.session;
  }

  /** The MCP endpoint this client talks to. */
  get endpoint(): string {
    return this.session.mcpUrl;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async renew(): Promise<void> {
    try {
      this.session = await refresh(this.options.fetch, this.session, this.now());
    } catch (error) {
      throw new AccountSignInRequiredError(
        `Your PopNow sign-in expired. Sign in again. (${error instanceof Error ? error.message : "refresh failed"})`,
      );
    }
    await this.options.onSession(this.session);
  }

  private async post(
    body: Record<string, unknown>,
    retried = false,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (this.session.expiresAt !== undefined && this.session.expiresAt - 30_000 < this.now() && !retried) {
      await this.renew();
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.session.accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": this.protocolVersion,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const response = await this.options.fetch(this.session.mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 && !retried) {
      await this.renew();
      return this.post(body, true, timeoutMs, signal);
    }
    if (response.status === 401) throw new AccountSignInRequiredError();
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300).trim();
      const challenge = response.headers.get("www-authenticate");
      throw new Error(
        `the PopNow server answered ${response.status}${detail ? `: ${detail}` : ""}${challenge ? ` (${challenge})` : ""}`,
      );
    }
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    return response;
  }

  private async request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!this.initialized && method !== "initialize") await this.initialize();
    const id = this.nextId++;
    // Creation tools wait up to about 40 seconds on the server before handing back a job id.
    const response = await this.post(
      { jsonrpc: "2.0", id, method, params },
      false,
      method === "tools/call" ? 120_000 : 30_000,
      signal,
    );
    return readReply(response, id);
  }

  private async initialize(): Promise<void> {
    this.initialized = true;
    const result = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.options.clientName ?? "popnow-davinci", version: this.options.clientVersion },
    });
    if (typeof result.protocolVersion === "string" && result.protocolVersion) this.protocolVersion = result.protocolVersion;
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.request("tools/list", cursor ? { cursor } : {});
      if (Array.isArray(result.tools)) tools.push(...(result.tools as McpTool[]));
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    return (await this.request("tools/call", { name, arguments: args }, signal)) as McpToolResult;
  }

  /** The session as it is now (after any refresh). */
  get currentSession(): AccountSession {
    return this.session;
  }
}

/** The credit price a tool asks the user to confirm, when it stopped to ask. */
export function confirmationCredits(result: McpToolResult): number | undefined {
  const data = result.structuredContent;
  if (!data || data.needs_confirmation !== true) return undefined;
  const credits = data.credits;
  return typeof credits === "number" && Number.isFinite(credits) && credits > 0 ? credits : undefined;
}

/** Whether a tool stopped to ask for consent about people in the user's media. */
export function needsConsent(result: McpToolResult): boolean {
  return result.structuredContent?.needs_consent === true;
}

/** The plain text of a tool result. */
export function resultText(result: McpToolResult): string {
  return (result.content ?? [])
    .filter((item) => item.type === "text" && item.text)
    .map((item) => item.text as string)
    .join("\n");
}

/** Text and links from a tool result. */
export function describeResult(result: McpToolResult): string[] {
  const lines: string[] = [];
  for (const item of result.content ?? []) {
    if (item.type === "text" && item.text) lines.push(item.text);
    else if (item.type === "resource_link" && item.uri) lines.push(item.uri);
    else if (item.type === "resource" && item.resource?.uri) lines.push(item.resource.uri);
    else if (item.type === "image") lines.push("(image preview omitted)");
  }
  return lines;
}
