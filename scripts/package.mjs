// Zips the plugin folder, the Resolve script and the installers into dist/popnow-davinci-<version>.zip.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const name = `popnow-davinci-${version}`;
const stage = join(root, "build", name);
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, "build", "ai.popnow.resolve"), join(stage, "ai.popnow.resolve"), { recursive: true });
mkdirSync(join(stage, "script"), { recursive: true });
cpSync(join(root, "script", "PopNow.py"), join(stage, "script", "PopNow.py"));
for (const file of ["install.sh", "install.ps1", "README.md", "LICENSE", "CHANGELOG.md"]) cpSync(join(root, file), join(stage, file));
mkdirSync(join(root, "dist"), { recursive: true });
const zip = join(root, "dist", `${name}.zip`);
rmSync(zip, { force: true });
execFileSync("zip", ["-qr", "-X", zip, name], { cwd: join(root, "build"), stdio: "inherit" });
console.log(`packaged ${zip}`);
