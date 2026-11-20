import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * What signing in keeps on disk: the OAuth client it registered and the tokens for the PopNow
 * account. The file is created with mode 0600 inside a 0700 folder in the user's own profile; the
 * Workflow Integration plugin and the Resolve script share it. Tokens are never printed or logged.
 */
export interface AccountSession {
  /** OAuth issuer the tokens came from, for example https://api.popnow.ai. */
  issuer: string;
  /** The MCP endpoint the tokens are for (the OAuth resource). */
  mcpUrl: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  /** Unix milliseconds; absent when the server did not say. */
  expiresAt?: number;
  scope?: string;
}

/** `POPNOW_CONFIG_DIR`, else `%APPDATA%\PopNow` on Windows, else `~/Library/Application Support/PopNow` on macOS. */
export function configDirectory(
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.POPNOW_CONFIG_DIR) return env.POPNOW_CONFIG_DIR;
  if (platform === "win32" && env.APPDATA) return join(env.APPDATA, "PopNow");
  if (platform === "darwin") return join(home, "Library", "Application Support", "PopNow");
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "popnow");
}

/** The sign-in file shared by the plugin and the Resolve script. */
export function sessionPath(env: NodeJS.ProcessEnv, home?: string, platform?: NodeJS.Platform): string {
  return join(configDirectory(env, home, platform), "davinci-resolve.json");
}

export async function readSession(path: string): Promise<AccountSession | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: Partial<AccountSession>;
  try {
    value = JSON.parse(text) as Partial<AccountSession>;
  } catch {
    return undefined; // a damaged file counts as signed out; `popnow login` writes a fresh one
  }
  if (value === null || typeof value !== "object") return undefined;
  if (
    typeof value.accessToken !== "string" ||
    typeof value.clientId !== "string" ||
    typeof value.tokenEndpoint !== "string" ||
    typeof value.mcpUrl !== "string" ||
    typeof value.issuer !== "string"
  ) {
    return undefined;
  }
  return value as AccountSession;
}

export async function writeSession(path: string, session: AccountSession): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  // Write a new private file and move it into place, so the tokens never sit in a file other users can read.
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600).catch(() => undefined);
  await rename(temp, path);
}

export async function deleteSession(path: string): Promise<void> {
  await rm(path, { force: true });
}
