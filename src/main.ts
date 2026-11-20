import { existsSync } from "node:fs";
import { join } from "node:path";

import { app, BrowserWindow, ipcMain, shell } from "electron";

import { ACTIONS } from "./core/actions.js";
import { PRICING_URL } from "./core/flow.js";
import { Panel } from "./core/panel.js";
import { sessionPath } from "./core/store.js";
import { ResolveHost } from "./host/resolve.js";
import { VERSION } from "./version.js";

/**
 * Electron main process of the Workflow Integration plugin (DaVinci Resolve Studio only).
 * The window is sandboxed with context isolation; it only reaches this process through the
 * small bridge in preload.js. Sign-in, uploads, prices and runs all happen here.
 */

export const PLUGIN_ID = "ai.popnow.resolve";
const ROOT = join(__dirname, "..");

// Resolve ships WorkflowIntegration.node with its developer samples; install.sh copies it next to
// main.js. If it is missing, fall back to the copy inside Resolve's own install.
const MODULE_PATHS = [
  join(ROOT, "WorkflowIntegration.node"),
  "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Workflow Integrations/Examples/SamplePlugin/WorkflowIntegration.node",
  join(process.env.PROGRAMDATA ?? "C:\\ProgramData", "Blackmagic Design", "DaVinci Resolve", "Support", "Developer", "Workflow Integrations", "Examples", "SamplePlugin", "WorkflowIntegration.node"),
];

interface WorkflowIntegration {
  Initialize(id: string): boolean;
  GetResolve(): unknown;
  CleanUp(): boolean;
}

function loadIntegration(): WorkflowIntegration {
  const path = MODULE_PATHS.find((candidate) => existsSync(candidate));
  if (!path) throw new Error("WorkflowIntegration.node was not found. Run install.sh again, or reinstall DaVinci Resolve Studio.");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(path) as WorkflowIntegration;
}

let integration: WorkflowIntegration | undefined;
let resolveHost: ResolveHost | undefined;

function host(): ResolveHost {
  if (resolveHost) return resolveHost;
  integration ??= loadIntegration();
  if (!integration.Initialize(PLUGIN_ID)) throw new Error("DaVinci Resolve did not accept the plugin. Workflow Integrations need DaVinci Resolve Studio.");
  const resolve = integration.GetResolve();
  if (!resolve) throw new Error("Could not reach DaVinci Resolve.");
  resolveHost = new ResolveHost(resolve);
  return resolveHost;
}

/** Only https pages leave the plugin, in the user's own browser. */
async function openUrl(url: string): Promise<boolean> {
  if (!/^https:\/\//i.test(url)) return false;
  await shell.openExternal(url);
  return true;
}

const panel = new Panel({
  fetch: globalThis.fetch.bind(globalThis),
  host: {
    currentClip: () => host().currentClip(),
    exportFrame: (folder, name) => host().exportFrame(folder, name),
    playheadFrame: () => host().playheadFrame(),
    place: (paths, kind, frame) => host().place(paths, kind, frame),
  },
  sessionPath: sessionPath(process.env),
  mediaFolder: join(app.getPath("videos"), "PopNow"),
  tempFolder: join(app.getPath("temp"), "popnow-resolve"),
  openUrl,
  version: VERSION,
});

type Reply = { ok: true; value: unknown } | { ok: false; error: string; signIn?: boolean };

function handle(channel: string, run: (send: (text: string) => void, ...args: unknown[]) => Promise<unknown> | unknown): void {
  ipcMain.handle(`popnow:${channel}`, async (event, ...args): Promise<Reply> => {
    const send = (text: string): void => event.sender.send("popnow:status", text);
    try {
      return { ok: true, value: await run(send, ...args) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message, ...(error instanceof Error && error.name === "AccountSignInRequiredError" ? { signIn: true } : {}) };
    }
  });
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function wire(): void {
  handle("actions", () =>
    ACTIONS.map(({ id, title, source, output, free, consent, fields }) => ({ id, title, source, output, free: free === true, consent: consent === true, fields })),
  );
  handle("status", () => panel.status());
  handle("login", () => panel.login());
  handle("cancelLogin", () => panel.cancelLogin());
  handle("logout", () => panel.logout());
  handle("balance", () => panel.balance());
  handle("context", () => panel.context());
  handle("price", (send, actionId, values) => panel.price(String(actionId), record(values), send));
  handle("create", (send, quoteId, choice) => panel.create(String(quoteId), { consent: record(choice).consent === true }, send));
  handle("stopWaiting", () => panel.stopWaiting());
  handle("getCredits", () => openUrl(PRICING_URL));
  handle("openLibrary", () => openUrl("https://popnow.ai/assets"));
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 380,
    height: 680,
    minWidth: 340,
    minHeight: 520,
    title: "PopNow",
    backgroundColor: "#FAF4E8",
    useContentSize: true,
    webPreferences: {
      preload: join(ROOT, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // The panel never navigates or opens windows; links go to the browser through openUrl.
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  void window.loadFile(join(ROOT, "index.html"));
}

wire();
void app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  panel.stopWaiting();
  panel.cancelLogin();
  integration?.CleanUp();
  app.quit();
});
