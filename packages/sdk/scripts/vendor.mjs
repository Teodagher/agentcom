// Copies the built SDK (dist/*.js, without the conformance suite or the type declarations) into the Claude Code
// plugin, which must run with nothing to npm install: plugin/vendor/agentcom-sdk/.
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "../dist");
const out = join(here, "../../../plugin/vendor/agentcom-sdk");
const { version } = JSON.parse(readFileSync(join(here, "../package.json"), "utf8"));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of readdirSync(dist)) if (f.endsWith(".js")) cpSync(join(dist, f), join(out, f));
writeFileSync(join(out, "package.json"), JSON.stringify({ name: "agentcom-sdk", version, type: "module", main: "index.js", private: true, description: "Vendored copy of packages/sdk (npm run vendor). Do not edit." }, null, 2) + "\n");
console.log(`vendored agentcom-sdk ${version} into plugin/vendor/agentcom-sdk`);
