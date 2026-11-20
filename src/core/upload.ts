import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";

import type { AccountClient } from "./mcp.js";

/**
 * Puts files from this computer (a clip's source file, an exported frame) into the signed-in
 * account and returns their popnow:// links, in order. Ported from popnow-cli src/account/upload.ts.
 *
 * It uses the same upload window an AI app opens with `request_upload`: the window's link carries a
 * one-time token, the files go straight to storage through the window's public endpoints (the signed
 * storage address never gets the Authorization header), and `get_upload` hands back the links.
 */

export interface LocalFile {
  path: string;
  contentType: string;
}

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
};

export function contentTypeOf(path: string): string {
  const type = TYPES[extname(path).toLowerCase()];
  if (!type) throw new TypeError(`PopNow can't use ${extname(path) || "these"} files. Use MP4, MOV, PNG, JPG, WAV or MP3.`);
  return type;
}

function kindOf(contentType: string): "image" | "video" | "audio" {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  throw new TypeError(`PopNow can't use ${contentType} files. Use MP4, MOV, PNG, JPG, WAV or MP3.`);
}

async function envelope(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as { code?: number; msg?: string; data?: unknown };
  if (!response.ok || body.code !== 200) {
    throw new Error(body.msg ? `Upload failed: ${body.msg}` : `Upload failed (${response.status})`);
  }
  return (body.data ?? {}) as Record<string, unknown>;
}

export interface UploadOptions {
  signal?: AbortSignal;
  /** Called before each file goes up. */
  onFile?: (name: string, index: number, total: number) => void;
}

export async function uploadFiles(
  client: AccountClient,
  fetchImpl: typeof fetch,
  files: readonly LocalFile[],
  options: UploadOptions = {},
): Promise<string[]> {
  if (files.length === 0) return [];
  if (files.length > 10) throw new TypeError("Upload at most 10 files at once.");
  const kinds = [...new Set(files.map((file) => kindOf(file.contentType)))];
  const opened = await client.callTool(
    "request_upload",
    { kinds, max_files: files.length, note: "From DaVinci Resolve" },
    options.signal,
  );
  const data = opened.structuredContent ?? {};
  const uploadId = typeof data.upload_id === "string" ? data.upload_id : undefined;
  const pageUrl = typeof data.url === "string" ? data.url : undefined;
  if (!uploadId || !pageUrl) throw new Error("PopNow did not open an upload window.");
  const token = new URL(pageUrl).pathname.split("/").filter(Boolean).at(-1) ?? "";
  const api = `${new URL(client.endpoint).origin}/console/v1/upload-sessions/${encodeURIComponent(token)}`;
  const timeout = (ms: number): AbortSignal =>
    options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  const post = (path: string, body?: unknown): Promise<Response> =>
    fetchImpl(`${api}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: timeout(30_000),
    });

  const names: string[] = [];
  for (const [index, file] of files.entries()) {
    const bytes = await readFile(file.path);
    const size = bytes.length;
    const name = basename(file.path);
    names.push(name);
    options.onFile?.(name, index, files.length);
    const ticket = await envelope(await post("/files", { contentType: file.contentType, bytes: size, name }));
    const uploadUrl = ticket.uploadUrl;
    const fileId = ticket.fileId;
    if (typeof uploadUrl !== "string" || typeof fileId !== "string") throw new Error("Upload failed: no upload address.");
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((ticket.headers ?? {}) as Record<string, string>)) {
      // The signed address is all the permission storage needs: never forward Authorization to it.
      if (!/^(content-length|host|authorization)$/i.test(key)) headers[key] = value;
    }
    const put = await fetchImpl(uploadUrl, {
      method: typeof ticket.method === "string" ? ticket.method : "PUT",
      headers,
      body: bytes,
      signal: timeout(30 * 60_000),
    });
    if (!put.ok) throw new Error(`Upload of ${name} failed (${put.status}).`);
    await envelope(await post(`/files/${encodeURIComponent(fileId)}/commit`));
  }
  await post("/close").then(envelope).catch(() => undefined);

  const result = await client.callTool("get_upload", { upload_id: uploadId, wait_seconds: 0 }, options.signal);
  const listed = Array.isArray(result.structuredContent?.files)
    ? (result.structuredContent.files as { popnow_link?: unknown; name?: unknown }[])
    : [];
  const links: string[] = [];
  const unused = [...listed];
  for (const name of names) {
    const at = unused.findIndex((item) => item.name === name);
    const item = at >= 0 ? unused.splice(at, 1)[0] : unused.shift();
    if (!item || typeof item.popnow_link !== "string") throw new Error(`PopNow did not return a link for ${name}.`);
    links.push(item.popnow_link);
  }
  return links;
}

/**
 * Remembers what was already uploaded in this session (same path, size and modified time), so
 * asking for a price again or trying another action on the same clip doesn't send it twice.
 */
export class UploadCache {
  private readonly links = new Map<string, string>();

  async link(client: AccountClient, fetchImpl: typeof fetch, path: string, options: UploadOptions = {}): Promise<string> {
    const info = await stat(path);
    const key = `${path}\u0000${info.size}\u0000${info.mtimeMs}`;
    const known = this.links.get(key);
    if (known) return known;
    const [link] = await uploadFiles(client, fetchImpl, [{ path, contentType: contentTypeOf(path) }], options);
    if (!link) throw new Error("PopNow did not return a link for the upload.");
    this.links.set(key, link);
    return link;
  }

  clear(): void {
    this.links.clear();
  }
}
