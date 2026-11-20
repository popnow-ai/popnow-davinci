import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ACTIONS, actionById, defaults } from "../src/core/actions.js";
import { discover } from "../src/core/oauth.js";
import { Panel, type HostLike } from "../src/core/panel.js";
import { configDirectory } from "../src/core/store.js";
import { timecodeToFrames } from "../src/host/resolve.js";
import { startFake, type Fake } from "./fake.js";

interface Placed {
  paths: readonly string[];
  kind: string;
  frame: number;
}

function fakeHost(dir: string, placed: Placed[]): HostLike {
  return {
    currentClip: async () => ({ name: "Interview A", filePath: join(dir, "interview.mov"), recordFrame: 86_520, seconds: 6.25 }),
    exportFrame: async (folder, name) => {
      const path = join(folder, name);
      await writeFile(path, Buffer.from([137, 80, 78, 71]));
      return { path, recordFrame: 86_600 };
    },
    playheadFrame: async () => 86_700,
    place: async (paths, kind, frame) => {
      placed.push({ paths, kind, frame });
      return { track: 3, trackType: kind === "audio" ? "audio" : "video", count: paths.length };
    },
  };
}

describe("DaVinci Resolve panel", () => {
  let fake: Fake;
  let dir: string;
  let placed: Placed[];
  let opened: string[];

  beforeEach(async () => {
    fake = await startFake();
    dir = await mkdtemp(join(tmpdir(), "popnow-resolve-"));
    await writeFile(join(dir, "interview.mov"), Buffer.alloc(2048, 7));
    placed = [];
    opened = [];
  });
  afterEach(async () => {
    fake.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const panel = (openUrl?: (url: string) => Promise<boolean>): Panel =>
    new Panel({
      fetch: globalThis.fetch,
      host: fakeHost(dir, placed),
      sessionPath: join(dir, "config", "davinci-resolve.json"),
      mediaFolder: join(dir, "media"),
      tempFolder: join(dir, "tmp"),
      mcpUrl: `${fake.origin}/mcp`,
      version: "0.1.0-test",
      // The "browser" follows the sign-in link, which redirects back to the loopback port.
      openUrl:
        openUrl ??
        (async (url) => {
          opened.push(url);
          await fetch(url);
          return true;
        }),
    });

  async function signedIn(): Promise<Panel> {
    const p = panel();
    await p.login();
    return p;
  }

  const toolCalls = (name: string) => fake.calls.filter((c) => c.method === "tools/call" && c.name === name);

  it("signs in with OAuth, PKCE and a loopback redirect, and keeps the tokens in a 0600 file", async () => {
    const p = await signedIn();
    expect(await p.status()).toEqual({ signedIn: true });
    const reg = fake.registered[0] as { redirect_uris: string[]; token_endpoint_auth_method: string; client_name: string; scope: string };
    expect(reg.redirect_uris[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(reg.token_endpoint_auth_method).toBe("none");
    expect(reg.client_name).toBe("PopNow for DaVinci Resolve");
    expect(reg.scope).toBe("generate read");
    expect(opened[0]).toContain("/oauth/authorize?");
    const file = join(dir, "config", "davinci-resolve.json");
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(file, "utf8")) as { accessToken: string; refreshToken: string };
    expect(saved).toMatchObject({ accessToken: "at-1", refreshToken: "rt-1" });
  });

  it("answers a stray callback with the wrong state with 400 and keeps waiting", async () => {
    const p = panel(async (url) => {
      const redirect = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", "evil");
      redirect.searchParams.set("state", "wrong");
      expect((await fetch(redirect)).status).toBe(400);
      const wrongIssuer = new URL(redirect);
      wrongIssuer.searchParams.set("state", new URL(url).searchParams.get("state") ?? "");
      wrongIssuer.searchParams.set("iss", "https://evil.example");
      expect((await fetch(wrongIssuer)).status).toBe(400);
      await fetch(url);
      return true;
    });
    await expect(p.login()).resolves.toEqual({ signedIn: true });
    expect(fake.tokens.issued).toBe(1);
  });

  it("can cancel a sign-in that is waiting for the browser", async () => {
    let p: Panel | undefined;
    p = panel(async () => {
      setTimeout(() => p?.cancelLogin(), 10);
      return true;
    });
    await expect(p.login()).rejects.toThrow(/canceled/i);
    expect(await p.status()).toEqual({ signedIn: false });
  });

  it("refuses sign-in servers that are not https or whose issuer does not match", async () => {
    await expect(discover(fetch, "http://popnow.example/mcp")).rejects.toThrow(/https/);
    fake.meta = { issuer: "https://other.example" };
    await expect(discover(fetch, `${fake.origin}/mcp`)).rejects.toThrow(/issuer/);
    fake.meta = { token_endpoint: "http://popnow.example/oauth/token" };
    await expect(discover(fetch, `${fake.origin}/mcp`)).rejects.toThrow(/https/);
  });

  it("uploads the clip's source file through an upload window and prices it without starting anything", async () => {
    const p = await signedIn();
    const quote = await p.price("edit-video", { prompt: "make it snow" });
    expect(quote).toMatchObject({ credits: 400, free: false, balance: 1000, affordable: true, consent: false });
    expect(fake.uploads).toEqual([
      "POST /files",
      "file interview.mov:2048:video/quicktime",
      "PUT /put/f1:2048",
      "POST /files/f1/commit",
      "POST /close",
    ]);
    // The signed storage address never gets the Authorization header, not even one the ticket names.
    expect(fake.putAuth).toEqual([undefined]);
    expect(toolCalls("estimate_cost")[0]?.args).toEqual({ tool: "edit_video", arguments: { video_url: "popnow://f/src", prompt: "make it snow" } });
    expect(toolCalls("edit_video")).toHaveLength(0);

    // Asking again (another prompt) does not upload the same file twice.
    await p.price("edit-video", { prompt: "make it rain" });
    expect(fake.uploads.filter((u) => u.startsWith("PUT"))).toHaveLength(1);
  });

  it("starts only at the quoted price, polls get_job, downloads and puts the result on a new track", async () => {
    const p = await signedIn();
    const quote = await p.price("edit-video", { prompt: "make it snow" });
    const statuses: string[] = [];
    const done = await p.create(quote.quoteId, {}, (s) => statuses.push(s));
    expect(done).toMatchObject({ kind: "done", track: 3, trackType: "video" });
    expect(toolCalls("edit_video").map((c) => c.args)).toEqual([{ video_url: "popnow://f/src", prompt: "make it snow", max_credits: 400 }]);
    expect(toolCalls("get_job").length).toBeGreaterThanOrEqual(1);
    expect(placed).toHaveLength(1);
    expect(placed[0]?.kind).toBe("video");
    expect(placed[0]?.frame).toBe(86_520);
    expect(placed[0]?.paths[0]).toMatch(/popnow-edit-video-\d{8}-\d{6}\.mp4$/);
    expect(await readFile(placed[0]!.paths[0]!, "utf8")).toBe("result-bytes");
    expect(statuses).toContain("Bringing it into Resolve…");

    // One click, one run: the same quote cannot start a second job.
    expect(await p.create(quote.quoteId, {})).toMatchObject({ kind: "error" });
    expect(toolCalls("edit_video")).toHaveLength(1);
  });

  it("never follows a higher price: nothing starts and the new price needs a new click", async () => {
    const p = await signedIn();
    const quote = await p.price("edit-video", { prompt: "x" });
    fake.raiseBy = 50;
    const outcome = await p.create(quote.quoteId, {});
    expect(outcome.kind).toBe("price_changed");
    if (outcome.kind !== "price_changed") return;
    expect(outcome.quote.credits).toBe(450);
    const runs = toolCalls("edit_video");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.args?.max_credits).toBe(400);
    expect(toolCalls("get_job")).toHaveLength(0);

    // Only a new click on the new price sends 450.
    const again = await p.create(outcome.quote.quoteId, {});
    expect(again.kind).toBe("done");
    expect(toolCalls("edit_video").at(-1)?.args?.max_credits).toBe(450);
  });

  it("does not charge when the user only asked for the price", async () => {
    const p = await signedIn();
    await p.price("text-to-video", { prompt: "a foggy forest", aspect_ratio: "16:9", duration_seconds: "5" });
    expect(toolCalls("create_video")).toHaveLength(0);
    expect(fake.calls.some((c) => c.args?.max_credits !== undefined)).toBe(false);
  });

  it("marks a price above the balance as not affordable, and reports not enough credits", async () => {
    fake.balance = 100;
    const p = await signedIn();
    const quote = await p.price("edit-video", { prompt: "x" });
    expect(quote.affordable).toBe(false);
    expect(await p.create(quote.quoteId, {})).toMatchObject({ kind: "not_enough" });
  });

  it("needs the user's own consent before dubbing, and only then sends consent: true", async () => {
    const p = await signedIn();
    const quote = await p.price("translate", defaults(actionById("translate")));
    expect(quote.consent).toBe(true);
    expect(await p.create(quote.quoteId, {})).toMatchObject({ kind: "needs_consent" });
    expect(toolCalls("translate_video")).toHaveLength(0);

    const ticked = await p.create(quote.quoteId, { consent: true });
    expect(ticked.kind).toBe("done");
    expect(toolCalls("translate_video")[0]?.args).toEqual({ video_url: "popnow://f/src", target_language: "es", max_credits: 900, consent: true });
  });

  it("treats a consent request from PopNow as needs_consent, not as an error", async () => {
    const p = await signedIn();
    const quote = await p.price("translate", { target_language: "ja" });
    // Even if the panel's own check were skipped, the server's request comes back as needs_consent.
    (p as unknown as { pending: Map<string, { action: { consent: boolean } }> }).pending.get(quote.quoteId)!.action = {
      ...actionById("translate"),
      consent: false,
    };
    expect(await p.create(quote.quoteId, {})).toMatchObject({ kind: "needs_consent" });
  });

  it("runs the free Reframe without a price check or max_credits", async () => {
    const p = await signedIn();
    const quote = await p.price("reframe", { aspect_ratio: "9:16" });
    expect(quote).toMatchObject({ free: true, credits: 0, affordable: true });
    expect(toolCalls("estimate_cost")).toHaveLength(0);
    await p.create(quote.quoteId, {});
    expect(toolCalls("reframe_video")[0]?.args).toEqual({ video_url: "popnow://f/src", aspect_ratio: "9:16" });
  });

  it("puts Video to audio, Music and Voiceover on an audio track", async () => {
    const p = await signedIn();
    const sound = await p.price("add-sound", { prompt: "" });
    expect(toolCalls("estimate_cost")[0]?.args).toEqual({ tool: "add_sound", arguments: { video_url: "popnow://f/src", duration_seconds: 6 } });
    await p.create(sound.quoteId, {});
    const music = await p.price("music", { prompt: "lo-fi", instrumental: true });
    await p.create(music.quoteId, {});
    expect(placed.map((x) => [x.kind, x.frame])).toEqual([
      ["audio", 86_520],
      ["audio", 86_700],
    ]);
    expect(placed[1]?.paths[0]).toMatch(/\.mp3$/);
  });

  it("exports the current frame, uploads it and turns it into a video", async () => {
    const p = await signedIn();
    const quote = await p.price("frame-to-video", { prompt: "slow push in", duration_seconds: "5" });
    expect(fake.uploads.find((u) => u.startsWith("file "))).toMatch(/^file frame-\d+\.png:4:image\/png$/);
    await p.create(quote.quoteId, {});
    expect(toolCalls("create_video")[0]?.args).toMatchObject({ image_url: "popnow://f/src", prompt: "slow push in", duration_seconds: 5, max_credits: 185 });
    expect(placed[0]).toMatchObject({ kind: "video", frame: 86_600 });
  });

  it("stops waiting without cancelling the job on PopNow", async () => {
    fake.pollsBeforeDone = 50;
    fake.pollDelay = 30;
    const p = await signedIn();
    const quote = await p.price("edit-video", { prompt: "x" });
    const running = p.create(quote.quoteId, {});
    await new Promise((r) => setTimeout(r, 120));
    p.stopWaiting();
    const outcome = await running;
    expect(outcome.kind).toBe("stopped");
    if (outcome.kind === "stopped") expect(outcome.text).toMatch(/keeps making it/);
    expect(placed).toHaveLength(0);
    expect(fake.calls.some((c) => c.name === "cancel_job")).toBe(false);
  });

  it("refreshes an expired token once and saves the new one", async () => {
    const p = await signedIn();
    fake.expire = "at-1";
    expect(await p.balance()).toBe(1000);
    expect(fake.tokens.refreshed).toBe(1);
    const saved = JSON.parse(await readFile(join(dir, "config", "davinci-resolve.json"), "utf8")) as { accessToken: string; refreshToken: string };
    expect(saved).toMatchObject({ accessToken: "at-2", refreshToken: "rt-1" });
  });

  it("reads plain JSON replies as well as event streams", async () => {
    fake.json = true;
    const p = await signedIn();
    expect(await p.balance()).toBe(1000);
  });

  it("signs out, revokes both tokens and removes the file", async () => {
    const p = await signedIn();
    expect(await p.logout()).toEqual({ signedIn: false });
    expect(fake.tokens.revoked).toEqual(["rt-1", "at-1"]);
    await expect(stat(join(dir, "config", "davinci-resolve.json"))).rejects.toThrow();
    await expect(p.balance()).rejects.toThrow(/Sign in/);
  });

  it("expires quotes after ten minutes", async () => {
    let now = Date.now();
    const p = new Panel({
      fetch: globalThis.fetch,
      host: fakeHost(dir, placed),
      sessionPath: join(dir, "config", "davinci-resolve.json"),
      mediaFolder: join(dir, "media"),
      tempFolder: join(dir, "tmp"),
      mcpUrl: `${fake.origin}/mcp`,
      version: "t",
      now: () => now,
      openUrl: async (url) => {
        await fetch(url);
        return true;
      },
    });
    await p.login();
    const quote = await p.price("voiceover", { text: "hi", voice: "Kore" });
    now += 11 * 60_000;
    expect(await p.create(quote.quoteId, {})).toMatchObject({ kind: "error", text: expect.stringMatching(/out of date/) });
    expect(toolCalls("create_speech")).toHaveLength(0);
  });
});

describe("actions", () => {
  it("covers the clip, frame and text tools", () => {
    expect(ACTIONS.map((a) => `${a.source}:${a.tool}`)).toEqual([
      "clip:edit_video",
      "clip:add_sound",
      "clip:translate_video",
      "clip:upscale",
      "clip:reframe_video",
      "frame:edit_image",
      "frame:create_video",
      "text:create_video",
      "text:create_music",
      "text:create_speech",
    ]);
  });

  it("keeps Video to audio between 1 and 30 seconds", () => {
    const build = actionById("add-sound").build;
    expect(build({ values: {}, media: "popnow://f/a", clipSeconds: 0.2 }).duration_seconds).toBe(1);
    expect(build({ values: {}, media: "popnow://f/a", clipSeconds: 95 }).duration_seconds).toBe(30);
  });

  it("asks for the prompt instead of sending an empty one", () => {
    expect(() => actionById("edit-video").build({ values: { prompt: "  " }, media: "popnow://f/a" })).toThrow(/Write/);
  });

  it("never puts credits words other than credits, or API keys, in what users see", () => {
    const shown = JSON.stringify(ACTIONS.map(({ title, fields }) => ({ title, fields })));
    expect(shown).not.toMatch(/api key|\$|usd|sk-/i);
  });
});

describe("host helpers", () => {
  it("converts timecode to absolute frames, including drop-frame", () => {
    expect(timecodeToFrames("01:00:00:00", 24)).toBe(86_400);
    expect(timecodeToFrames("01:00:05:12", 25)).toBe(90_137);
    expect(timecodeToFrames("00:01:00;02", 29.97)).toBe(1800);
    expect(timecodeToFrames("00:10:00;00", 29.97)).toBe(17_982);
  });

  it("keeps the sign-in file in the user's own profile", () => {
    expect(configDirectory({}, "/Users/a", "darwin")).toBe("/Users/a/Library/Application Support/PopNow");
    expect(configDirectory({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "C:\\Users\\a", "win32")).toMatch(/PopNow$/);
  });
});
