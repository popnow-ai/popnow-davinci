// Compiles the main process and lays out the plugin folder Resolve loads:
//   build/ai.popnow.resolve/{manifest.xml, package.json, main.js, preload.js, index.html, ui.js, style.css, img/, fonts/, app/}
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "build", "ai.popnow.resolve");

rmSync(join(root, "build"), { recursive: true, force: true });
execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.json")], { stdio: "inherit" });
mkdirSync(out, { recursive: true });
cpSync(join(root, "plugin"), out, { recursive: true });
cpSync(join(root, "build", "app"), join(out, "app"), { recursive: true });
rmSync(join(root, "build", "app"), { recursive: true, force: true });
writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify({ name: "ai.popnow.resolve", productName: "PopNow", version: pkg.version, main: "main.js", private: true, license: "MIT" }, null, 2)}\n`,
);
const manifest = readFileSync(join(out, "manifest.xml"), "utf8");
if (!manifest.includes(`<Version>${pkg.version}</Version>`)) throw new Error("manifest.xml version does not match package.json");
const version = readFileSync(join(root, "src", "version.ts"), "utf8");
if (!version.includes(`"${pkg.version}"`)) throw new Error("src/version.ts does not match package.json");
console.log(`built ${out}`);
