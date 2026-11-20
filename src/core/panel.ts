import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";

import { actionById, type Action } from "./actions.js";
import {
  canAfford,
  download,
  quote,
  start,
  StoppedWaiting,
  waitForJob,
  type Job,
  type Quote,
  type StartOutcome,
} from "./flow.js";
import { AccountClient, AccountSignInRequiredError } from "./mcp.js";
import { DEFAULT_MCP_URL, login, revoke } from "./oauth.js";
import { deleteSession, readSession, writeSession, type AccountSession } from "./store.js";
import { UploadCache } from "./upload.js";

/**
 * Everything the panel can ask for, independent of Electron and of Resolve. The Electron main
 * process wires it to IPC; tests drive it with a fake host and a fake PopNow server.
 */

export interface ClipLike {
  name: string;
  filePath: string;
  recordFrame: number;
  seconds: number;
}

export interface HostLike {
  currentClip(): Promise<ClipLike>;
  exportFrame(folder: string, name: string): Promise<{ path: string; recordFrame: number }>;
  playheadFrame(): Promise<number>;
  place(paths: readonly string[], kind: "video" | "audio" | "image", recordFrame: number): Promise<{ track: number; trackType: string; count: number }>;
}

export interface PanelOptions {
  fetch: typeof fetch;
  host: HostLike;
  sessionPath: string;
  /** Where results are saved before they are imported. */
  mediaFolder: string;
  /** Where exported frames go before upload. */
  tempFolder: string;
  openUrl: (url: string) => Promise<boolean>;
  mcpUrl?: string;
  version: string;
  now?: () => number;
}

export interface PriceView {
  quoteId: string;
  credits: number;
  free: boolean;
  balance?: number;
  affordable: boolean;
  consent: boolean;
}

export type CreateView =
  | { kind: "done"; files: string[]; track: number; trackType: string; credits?: number }
  | { kind: "failed"; text: string }
  | { kind: "price_changed"; quote: PriceView }
  | { kind: "needs_consent"; text: string }
  | { kind: "not_enough"; text: string }
  | { kind: "stopped"; text: string }
  | { kind: "error"; text: string };

interface Pending {
  action: Action;
  quote: Quote;
  recordFrame: number;
  expires: number;
}

const QUOTE_TTL_MS = 10 * 60_000;

export class Panel {
  private readonly uploads = new UploadCache();
  private readonly pending = new Map<string, Pending>();
  private loginAbort: AbortController | undefined;
  private runAbort: AbortController | undefined;

  constructor(private readonly options: PanelOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private async session(): Promise<AccountSession> {
    const session = await readSession(this.options.sessionPath);
    if (!session) throw new AccountSignInRequiredError();
    return session;
  }

  private async client(): Promise<AccountClient> {
    return new AccountClient({
      fetch: this.options.fetch,
      session: await this.session(),
      onSession: (next) => writeSession(this.options.sessionPath, next),
      clientVersion: this.options.version,
      clientName: "popnow-davinci",
      ...(this.options.now ? { now: this.options.now } : {}),
    });
  }

  async status(): Promise<{ signedIn: boolean }> {
    return { signedIn: (await readSession(this.options.sessionPath)) !== undefined };
  }

  /** Opens PopNow sign-in in the browser and waits for it to come back to 127.0.0.1. */
  async login(): Promise<{ signedIn: true }> {
    this.loginAbort?.abort();
    const abort = new AbortController();
    this.loginAbort = abort;
    try {
      const session = await login({
        fetch: this.options.fetch,
        mcpUrl: this.options.mcpUrl ?? DEFAULT_MCP_URL,
        openUrl: this.options.openUrl,
        showUrl: () => undefined,
        signal: abort.signal,
        ...(this.options.now ? { now: this.options.now } : {}),
      });
      await writeSession(this.options.sessionPath, session);
      this.uploads.clear();
      return { signedIn: true };
    } finally {
      if (this.loginAbort === abort) this.loginAbort = undefined;
    }
  }

  cancelLogin(): void {
    this.loginAbort?.abort();
  }

  async logout(): Promise<{ signedIn: false }> {
    const session = await readSession(this.options.sessionPath);
    if (session) await revoke(this.options.fetch, session);
    await deleteSession(this.options.sessionPath);
    this.uploads.clear();
    this.pending.clear();
    return { signedIn: false };
  }

  async balance(): Promise<number | undefined> {
    const result = await (await this.client()).callTool("check_balance", {});
    const credits = result.structuredContent?.credits;
    return typeof credits === "number" ? credits : undefined;
  }

  /** What the clip and frame actions would use right now, for the panel's header. */
  async context(): Promise<{ clip?: { name: string; seconds: number }; problem?: string }> {
    try {
      const clip = await this.options.host.currentClip();
      return { clip: { name: clip.name, seconds: clip.seconds } };
    } catch (error) {
      return { problem: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Gets the input ready (uploads the clip's source file or the current frame, both free) and asks
   * PopNow for the price. Nothing is charged; the panel shows the result on its button.
   */
  async price(actionId: string, values: Record<string, unknown>, onStatus: (text: string) => void = () => undefined): Promise<PriceView> {
    const action = actionById(actionId);
    const client = await this.client();
    let media: string | undefined;
    let recordFrame: number;
    let clipSeconds: number | undefined;
    if (action.source === "clip") {
      const clip = await this.options.host.currentClip();
      onStatus(`Sending ${clip.name}…`);
      media = await this.uploads.link(client, this.options.fetch, clip.filePath);
      recordFrame = clip.recordFrame;
      clipSeconds = clip.seconds;
    } else if (action.source === "frame") {
      await mkdir(this.options.tempFolder, { recursive: true });
      const frame = await this.options.host.exportFrame(this.options.tempFolder, `frame-${this.now()}.png`);
      onStatus("Sending the frame…");
      media = await this.uploads.link(client, this.options.fetch, frame.path);
      recordFrame = frame.recordFrame;
    } else {
      recordFrame = await this.options.host.playheadFrame();
    }
    const args = action.build({ values, ...(media ? { media } : {}), ...(clipSeconds === undefined ? {} : { clipSeconds }) });
    onStatus("Checking the price…");
    const priced = await quote(client, action.tool, args, { free: action.free === true });
    return this.remember(action, priced, recordFrame);
  }

  private remember(action: Action, priced: Quote, recordFrame: number): PriceView {
    for (const [id, item] of this.pending) if (item.expires < this.now()) this.pending.delete(id);
    const quoteId = randomBytes(9).toString("base64url");
    this.pending.set(quoteId, { action, quote: priced, recordFrame, expires: this.now() + QUOTE_TTL_MS });
    return {
      quoteId,
      credits: priced.credits,
      free: priced.free,
      ...(priced.balance === undefined ? {} : { balance: priced.balance }),
      affordable: canAfford(priced),
      consent: action.consent === true,
    };
  }

  /**
   * Starts the run the user clicked on, at exactly that price, then waits for it, downloads the
   * result and puts it on a new track. `consent` is what the user ticked, nothing else.
   */
  async create(
    quoteId: string,
    choice: { consent?: boolean },
    onStatus: (text: string) => void = () => undefined,
  ): Promise<CreateView> {
    const item = this.pending.get(quoteId);
    if (!item || item.expires < this.now()) {
      this.pending.delete(quoteId);
      return { kind: "error", text: "That price is out of date. Check the price again." };
    }
    if (item.action.consent && choice.consent !== true) {
      return { kind: "needs_consent", text: "Tick the box to confirm you may use the face and voice in this clip." };
    }
    this.pending.delete(quoteId); // one click, one run
    const client = await this.client();
    const abort = new AbortController();
    this.runAbort = abort;
    try {
      onStatus("Starting…");
      const outcome: StartOutcome = await start(client, item.quote, {
        ...(choice.consent === true ? { consent: true } : {}),
        signal: abort.signal,
      });
      if (outcome.kind === "price_changed") {
        // Never follow a higher price: show it and let the user decide again.
        const again = this.remember(item.action, { ...item.quote, credits: outcome.credits }, item.recordFrame);
        return { kind: "price_changed", quote: again };
      }
      if (outcome.kind !== "started") return outcome;
      onStatus("You can keep editing.");
      const job: Job = await waitForJob(client, outcome.job, {
        signal: abort.signal,
        onWait: () => onStatus("You can keep editing."),
        ...(this.options.now ? { now: this.options.now } : {}),
      });
      if (job.status !== "succeeded") {
        return { kind: "failed", text: job.text || "This one didn't work. The credits were refunded automatically." };
      }
      if (job.files.length === 0) return { kind: "failed", text: job.text || "PopNow returned no file." };
      onStatus("Bringing it into Resolve…");
      const files = await download(this.options.fetch, job, this.options.mediaFolder, item.quote.tool, { signal: abort.signal });
      const placed = await this.options.host.place(files, item.action.output, item.recordFrame);
      return {
        kind: "done",
        files,
        track: placed.track,
        trackType: placed.trackType,
        ...(job.credits === undefined ? {} : { credits: job.credits }),
      };
    } catch (error) {
      if (error instanceof StoppedWaiting) return { kind: "stopped", text: error.message };
      if (abort.signal.aborted) {
        return { kind: "stopped", text: "Stopped waiting. If it had started, PopNow keeps making it and saves it to your library." };
      }
      throw error;
    } finally {
      if (this.runAbort === abort) this.runAbort = undefined;
    }
  }

  /** Stops waiting for the current run. This doesn't cancel the job on PopNow. */
  stopWaiting(): void {
    this.runAbort?.abort();
  }
}
