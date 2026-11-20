import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { expect } from "vitest";

/** A fake PopNow: OAuth server, account MCP endpoint, upload windows and a media host, on 127.0.0.1. */
export interface Fake {
  origin: string;
  server: Server;
  calls: { method: string; name?: string; args?: Record<string, unknown>; auth?: string }[];
  tokens: { issued: number; refreshed: number; revoked: string[] };
  registered: Record<string, unknown>[];
  uploads: string[];
  putAuth: (string | undefined)[];
  /** Credits each paid tool costs. */
  prices: Record<string, number>;
  balance: number;
  /** When set, the next MCP request with this token gets a 401 once. */
  expire?: string | undefined;
  /** How many get_job polls answer "running" before the job succeeds. */
  pollsBeforeDone: number;
  /** Delay for get_job answers, in ms. */
  pollDelay: number;
  /** Raise the real price after the quote (to test that max_credits is never followed upward). */
  raiseBy: number;
  /** Answer MCP with plain JSON instead of an event stream. */
  json: boolean;
  /** Override what the authorization-server metadata says. */
  meta?: Record<string, unknown>;
}

export function body(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const OUTPUT: Record<string, { file: string; type: string }> = {
  edit_video: { file: "out.mp4", type: "video/mp4" },
  translate_video: { file: "dub.mp4", type: "video/mp4" },
  upscale: { file: "up.mp4", type: "video/mp4" },
  reframe_video: { file: "tall.mp4", type: "video/mp4" },
  add_sound: { file: "sfx.mp3", type: "audio/mpeg" },
  create_music: { file: "song.mp3", type: "audio/mpeg" },
  create_speech: { file: "vo.mp3", type: "audio/mpeg" },
  edit_image: { file: "frame.png", type: "image/png" },
  create_video: { file: "clip.mp4", type: "video/mp4" },
};

export async function startFake(): Promise<Fake> {
  const fake: Fake = {
    origin: "",
    server: createServer(),
    calls: [],
    tokens: { issued: 0, refreshed: 0, revoked: [] },
    registered: [],
    uploads: [],
    putAuth: [],
    prices: { edit_video: 400, add_sound: 30, translate_video: 900, upscale: 120, edit_image: 48, create_video: 185, create_music: 72, create_speech: 20 },
    balance: 1000,
    pollsBeforeDone: 1,
    pollDelay: 0,
    raiseBy: 0,
    json: false,
  };
  let polls = 0;
  fake.server.on("request", async (request, response) => {
    const url = new URL(request.url ?? "/", fake.origin);
    const json = (status: number, value: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    };
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      json(200, { resource: `${fake.origin}/mcp`, authorization_servers: [fake.origin] });
    } else if (url.pathname === "/.well-known/oauth-authorization-server") {
      json(200, {
        issuer: fake.origin,
        authorization_endpoint: `${fake.origin}/oauth/authorize`,
        token_endpoint: `${fake.origin}/oauth/token`,
        registration_endpoint: `${fake.origin}/oauth/register`,
        revocation_endpoint: `${fake.origin}/oauth/revoke`,
        ...fake.meta,
      });
    } else if (url.pathname === "/oauth/register") {
      const reg = JSON.parse(await body(request)) as Record<string, unknown>;
      fake.registered.push(reg);
      json(201, { client_id: "pnc_resolve", redirect_uris: reg.redirect_uris });
    } else if (url.pathname === "/oauth/authorize") {
      const p = url.searchParams;
      expect(p.get("code_challenge_method")).toBe("S256");
      expect(p.get("resource")).toBe(`${fake.origin}/mcp`);
      expect(p.get("scope")).toBe("generate read");
      const back = new URL(p.get("redirect_uri") ?? "");
      back.searchParams.set("code", "code-1");
      back.searchParams.set("state", p.get("state") ?? "");
      back.searchParams.set("iss", fake.origin);
      response.writeHead(302, { location: back.toString() }).end();
    } else if (url.pathname === "/oauth/token") {
      const form = new URLSearchParams(await body(request));
      if (form.get("grant_type") === "authorization_code") {
        expect(form.get("code")).toBe("code-1");
        expect(form.get("code_verifier")).toBeTruthy();
        fake.tokens.issued++;
        json(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, scope: "generate read" });
      } else {
        expect(form.get("refresh_token")).toBe("rt-1");
        fake.tokens.refreshed++;
        json(200, { access_token: "at-2", expires_in: 3600 });
      }
    } else if (url.pathname === "/oauth/revoke") {
      fake.tokens.revoked.push(new URLSearchParams(await body(request)).get("token") ?? "");
      response.writeHead(200).end();
    } else if (url.pathname.startsWith("/console/v1/upload-sessions/tok123")) {
      const rest = url.pathname.slice("/console/v1/upload-sessions/tok123".length);
      const sent = await body(request);
      fake.uploads.push(`${request.method} ${rest}`);
      if (rest === "/files") {
        const req = JSON.parse(sent) as { name: string; bytes: number; contentType: string };
        fake.uploads.push(`file ${req.name}:${req.bytes}:${req.contentType}`);
        json(200, {
          code: 200,
          data: { fileId: "f1", uploadUrl: `${fake.origin}/put/f1`, method: "PUT", headers: { "content-type": req.contentType, authorization: "should-not-be-sent" } },
        });
      } else {
        json(200, { code: 200, data: { state: rest === "/close" ? "closed" : "open" } });
      }
    } else if (url.pathname.startsWith("/put/")) {
      fake.putAuth.push(request.headers.authorization);
      fake.uploads.push(`PUT ${url.pathname}:${(await body(request)).length}`);
      response.writeHead(200).end();
    } else if (url.pathname.startsWith("/media/")) {
      response.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.from("result-bytes"));
    } else if (url.pathname === "/mcp") {
      const auth = request.headers.authorization ?? "";
      if (fake.expire && auth === `Bearer ${fake.expire}`) {
        fake.expire = undefined;
        response.writeHead(401).end();
        return;
      }
      const message = JSON.parse(await body(request)) as {
        id?: number;
        method: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      fake.calls.push({
        method: message.method,
        auth,
        ...(message.params?.name ? { name: message.params.name } : {}),
        ...(message.params?.arguments ? { args: message.params.arguments } : {}),
      });
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const name = message.params?.name ?? "";
      const args = message.params?.arguments ?? {};
      const text = (t: string, structuredContent?: Record<string, unknown>, isError = false) => ({
        content: [{ type: "text", text: t }],
        ...(structuredContent ? { structuredContent } : {}),
        ...(isError ? { isError: true } : {}),
      });
      let result: unknown = {};
      if (message.method === "initialize") {
        result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake" } };
      } else if (name === "check_balance") {
        result = text(`You have ${fake.balance} PopNow credits.`, { currency: "credits", credits: fake.balance, held: 0 });
      } else if (name === "estimate_cost") {
        const tool = String(args.tool);
        const credits = fake.prices[tool] ?? 10;
        result = text(`${tool} would cost about ${credits} credits.`, { currency: "credits", credits, balance: fake.balance, steps: [credits] });
      } else if (name === "request_upload") {
        result = text("Upload page ready.", { upload_id: "up_1", url: `${fake.origin}/upload/tok123` });
      } else if (name === "get_upload") {
        result = text("1 file uploaded.", { upload_id: "up_1", state: "closed", files: [{ popnow_link: "popnow://f/src", name: "interview.mov", type: "video/quicktime" }] });
      } else if (name === "get_job") {
        if (fake.pollDelay) await new Promise((r) => setTimeout(r, fake.pollDelay));
        polls++;
        const tool = String(args.job_id).replace(/^job_/, "");
        const out = OUTPUT[tool] ?? { file: "x.bin", type: "application/octet-stream" };
        result =
          polls > fake.pollsBeforeDone
            ? text("Done!", { job_id: args.job_id, status: "succeeded", credits: 400, files: [{ url: `${fake.origin}/media/${out.file}`, popnow_link: "popnow://g/1", type: out.type }] })
            : text("Still making it.", { job_id: args.job_id, status: "running" });
      } else if (OUTPUT[name] || name === "reframe_video") {
        const price = (fake.prices[name] ?? 0) + fake.raiseBy;
        const max = typeof args.max_credits === "number" ? args.max_credits : 0;
        if (name === "translate_video" && args.consent !== true) {
          result = text("Before I can dub this video, the user has to confirm... call this tool again with consent: true. Nothing was charged.", undefined, true);
        } else if (name !== "reframe_video" && price > fake.balance) {
          result = text(`Not enough credits: this needs ${price} credits and you have ${fake.balance}. Nothing was charged.`, undefined, true);
        } else if (name !== "reframe_video" && price > max) {
          result = text(`Needs confirmation, nothing started yet. Costs ${price} credits.`, { currency: "credits", needs_confirmation: true, credits: price, balance: fake.balance });
        } else {
          polls = 0;
          result = text(`Started! job_id: job_${name}`, { job_id: `job_${name}`, status: "running", credits: price, currency: "credits" });
        }
      }
      if (fake.json) {
        json(200, { jsonrpc: "2.0", id: message.id, result });
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
  fake.origin = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  return fake;
}
