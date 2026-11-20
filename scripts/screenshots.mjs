// Renders the panel in headless Chrome with a fake host bridge (no Resolve, no PopNow) and saves
// docs/screenshots/panel-light.png and panel-dark.png. Run `npm run build` first.
//   node scripts/screenshots.mjs        (CHROME=/path/to/chrome to override the browser)
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(root, "build", "ai.popnow.resolve");
const out = join(root, "docs", "screenshots");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const require = createRequire(import.meta.url);
const { ACTIONS } = require(join(built, "app", "core", "actions.js"));
const actions = ACTIONS.map(({ id, title, source, output, free, consent, fields }) => ({ id, title, source, output, free: free === true, consent: consent === true, fields }));

// The fake bridge answers like the main process would, then drives the panel into one state.
const bridge = (scene) => `
(() => {
  const ok = (value) => Promise.resolve({ ok: true, value });
  let statusListener = () => {};
  const prices = { "edit-video": 400, "music": 72 };
  window.popnow = {
    actions: () => ok(${JSON.stringify(actions)}),
    status: () => ok({ signedIn: true }),
    balance: () => ok(12480),
    context: () => ok({ clip: { name: "A001_C014_beach_walk.mov", seconds: 6.2 } }),
    price: (id) => ok({ quoteId: "q1", credits: prices[id] || 48, free: false, balance: 12480, affordable: true, consent: false }),
    create: () => { setTimeout(() => statusListener("You can keep editing."), 50); return new Promise(() => {}); },
    stopWaiting: () => ok(), getCredits: () => ok(true), openLibrary: () => ok(true), login: () => ok(), logout: () => ok(), cancelLogin: () => ok(),
    onStatus: (fn) => { statusListener = fn; return () => {}; },
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const type = (text) => { const t = document.querySelector("#fields textarea"); t.value = text; t.dispatchEvent(new Event("input")); };
  addEventListener("load", async () => {
    await wait(100);
    ${scene}
  });
})();`;

const scenes = {
  light: {
    dark: false,
    script: `type("Turn it into a snowy evening, warm street lights"); await wait(50); document.getElementById("go").click();`,
  },
  dark: {
    dark: true,
    script: `document.querySelector('[data-tab="text"]').click(); await wait(80);
      [...document.querySelectorAll(".chip")].find((c) => c.textContent.startsWith("Music")).click(); await wait(50);
      type("Warm lo-fi beat for a sunset travel montage"); await wait(900); document.getElementById("go").click();`,
  },
};

mkdirSync(out, { recursive: true });
for (const [name, scene] of Object.entries(scenes)) {
  const dir = mkdtempSync(join(tmpdir(), "popnow-resolve-shot-"));
  cpSync(built, dir, { recursive: true });
  writeFileSync(join(dir, "fake-bridge.js"), bridge(scene.script));
  const html = readFileSync(join(dir, "index.html"), "utf8")
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
    // Headless Chrome won't make a window narrower than about 500px: pin the page to the panel's width.
    .replace("</head>", "<style>html,body{width:380px}</style></head>")
    .replace('<script src="ui.js"></script>', '<script src="fake-bridge.js"></script><script src="ui.js"></script>');
  writeFileSync(join(dir, "index.html"), html);
  const profile = mkdtempSync(join(tmpdir(), "popnow-chrome-"));
  execFileSync(CHROME, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${profile}`, "--allow-file-access-from-files", "--force-device-scale-factor=2",
    "--window-size=380,680", "--virtual-time-budget=4000",
    ...(scene.dark ? ["--force-dark-mode"] : []),
    `--screenshot=${join(out, `panel-${name}.png`)}`,
    `file://${join(dir, "index.html")}`,
  ], { stdio: "ignore" });
  rmSync(dir, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
  console.log(`saved docs/screenshots/panel-${name}.png`);
}
