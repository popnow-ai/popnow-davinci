import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { confirmationCredits, needsConsent, resultText, type AccountClient, type McpToolResult } from "./mcp.js";

/**
 * Price check, start, wait and download, with no UI and no Resolve in it.
 *
 * The rules that matter for money live here:
 * - the price comes from `estimate_cost` (free, starts nothing) before the user sees a button;
 * - a run is started only with `max_credits` set to the price the user saw, never more;
 * - if the server asks for more than that, nothing starts and the new price goes back to the user;
 * - `consent: true` is only sent when the user ticked the box themselves.
 */

export const PRICING_URL = "https://popnow.ai/pricing";

export interface Quote {
  tool: string;
  args: Record<string, unknown>;
  /** 0 for free tools. */
  credits: number;
  /** The account's credits when the price was checked; undefined when the server did not say. */
  balance?: number;
  free: boolean;
}

export function canAfford(quote: Quote): boolean {
  return quote.free || quote.balance === undefined || quote.credits <= quote.balance;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Asks PopNow what this costs. Free tools (Reframe) are not priced. */
export async function quote(
  client: AccountClient,
  tool: string,
  args: Record<string, unknown>,
  options: { free?: boolean; signal?: AbortSignal } = {},
): Promise<Quote> {
  if (options.free) return { tool, args, credits: 0, free: true };
  const result = await client.callTool("estimate_cost", { tool, arguments: args }, options.signal);
  if (result.isError) throw new Error(resultText(result) || "PopNow could not price this.");
  const credits = num(result.structuredContent?.credits);
  if (credits === undefined) throw new Error("PopNow did not return a price.");
  const balance = num(result.structuredContent?.balance);
  return { tool, args, credits, free: false, ...(balance === undefined ? {} : { balance }) };
}

export interface Job {
  jobId?: string;
  status: string;
  files: { url: string; popnowLink?: string; type?: string }[];
  credits?: number;
  text: string;
}

export type StartOutcome =
  | { kind: "started"; job: Job }
  | { kind: "price_changed"; credits: number; text: string }
  | { kind: "needs_consent"; text: string }
  | { kind: "not_enough"; text: string }
  | { kind: "error"; text: string };

export function jobFrom(result: McpToolResult): Job {
  const data = result.structuredContent ?? {};
  const files = Array.isArray(data.files)
    ? (data.files as Record<string, unknown>[])
        .filter((file) => typeof file.url === "string")
        .map((file) => ({
          url: file.url as string,
          ...(typeof file.popnow_link === "string" ? { popnowLink: file.popnow_link } : {}),
          ...(typeof file.type === "string" ? { type: file.type } : {}),
        }))
    : [];
  const credits = num(data.credits);
  return {
    ...(typeof data.job_id === "string" ? { jobId: data.job_id } : {}),
    status: typeof data.status === "string" ? data.status : files.length > 0 ? "succeeded" : "unknown",
    files,
    ...(credits === undefined ? {} : { credits }),
    text: resultText(result),
  };
}

const CONSENT_ASK = /consent:\s*true/i;
const NOT_ENOUGH = /not enough credits/i;

/** Classifies a tool reply the way the panel needs it. */
export function outcomeOf(result: McpToolResult): StartOutcome {
  const text = resultText(result);
  const credits = confirmationCredits(result);
  if (needsConsent(result) || (result.isError && CONSENT_ASK.test(text))) return { kind: "needs_consent", text };
  if (credits !== undefined) return { kind: "price_changed", credits, text };
  if (NOT_ENOUGH.test(text) && (result.isError || !result.structuredContent?.job_id)) return { kind: "not_enough", text };
  if (result.isError) return { kind: "error", text: text || "PopNow could not do this one." };
  return { kind: "started", job: jobFrom(result) };
}

/**
 * Starts the run at the quoted price. `max_credits` is exactly the price the user clicked on;
 * when the server wants more, it says so and nothing starts.
 */
export async function start(
  client: AccountClient,
  approved: Quote,
  options: { consent?: boolean; signal?: AbortSignal } = {},
): Promise<StartOutcome> {
  const args: Record<string, unknown> = { ...approved.args };
  delete args.max_credits;
  delete args.consent;
  if (!approved.free) args.max_credits = approved.credits;
  if (options.consent === true) args.consent = true;
  return outcomeOf(await client.callTool(approved.tool, args, options.signal));
}

export function isDone(job: Job): boolean {
  return job.status === "succeeded" || job.status === "failed" || job.status === "blocked";
}

/**
 * Polls `get_job` until the job is finished. Aborting the signal only stops waiting here: the job
 * keeps going on PopNow and ends up in the user's library.
 */
export async function waitForJob(
  client: AccountClient,
  job: Job,
  options: { signal?: AbortSignal; onWait?: (job: Job) => void; maxMs?: number; now?: () => number } = {},
): Promise<Job> {
  const now = options.now ?? Date.now;
  const until = now() + (options.maxMs ?? 30 * 60_000);
  let current = job;
  while (!isDone(current)) {
    if (!current.jobId) throw new Error("PopNow did not return a job to follow.");
    if (options.signal?.aborted) throw new StoppedWaiting(current.jobId);
    if (now() > until) throw new Error("This is taking longer than usual. It is still saved to your PopNow library when it finishes.");
    options.onWait?.(current);
    let result: McpToolResult;
    try {
      result = await client.callTool("get_job", { job_id: current.jobId, wait_seconds: 20 }, options.signal);
    } catch (error) {
      if (options.signal?.aborted) throw new StoppedWaiting(current.jobId);
      throw error;
    }
    const next = jobFrom(result);
    current = { ...next, jobId: next.jobId ?? current.jobId };
  }
  return current;
}

export class StoppedWaiting extends Error {
  constructor(readonly jobId: string) {
    super("Stopped waiting. PopNow keeps making it and saves it to your library.");
    this.name = "StoppedWaiting";
  }
}

const EXT: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/flac": ".flac",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

function extensionFor(file: { url: string; type?: string }): string {
  if (file.type && EXT[file.type]) return EXT[file.type] as string;
  const match = /\.([a-z0-9]{2,4})(?:$|\?)/i.exec(new URL(file.url).pathname);
  return match ? `.${match[1]!.toLowerCase()}` : ".bin";
}

/** Safe, readable file name for a result: popnow-<tool>-<time>[-n].<ext>. */
export function resultName(tool: string, index: number, file: { url: string; type?: string }, at: Date): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return `popnow-${tool.replace(/_/g, "-")}-${stamp}${index > 0 ? `-${index + 1}` : ""}${extensionFor(file)}`;
}

/** Downloads the results into a folder and returns the local paths. Download links carry no token. */
export async function download(
  fetchImpl: typeof fetch,
  job: Job,
  folder: string,
  tool: string,
  options: { signal?: AbortSignal; at?: Date } = {},
): Promise<string[]> {
  await mkdir(folder, { recursive: true });
  const at = options.at ?? new Date();
  const paths: string[] = [];
  for (const [index, file] of job.files.entries()) {
    const url = new URL(file.url);
    if (url.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(url.hostname)) {
      throw new Error("PopNow returned a download link that is not https.");
    }
    const response = await fetchImpl(file.url, {
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15 * 60_000)]) : AbortSignal.timeout(15 * 60_000),
    });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`);
    const path = join(folder, resultName(tool, index, file, at));
    const temp = `${path}.part`;
    try {
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(temp));
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    paths.push(path);
  }
  return paths;
}
