// Starts the reference server (../../server.js) on a free port with a throwaway data directory.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..");

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });

export async function startServer(env = {}, dataDir = null) {
  const port = await freePort();
  const dir = dataDir ?? mkdtempSync(join(tmpdir(), "agentcom-test-"));
  const child = spawn(process.execPath, [join(root, "server.js")], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, PUBLIC_ORIGIN: `http://127.0.0.1:${port}`, AGENTCOM_WRITES_PER_MIN: "100000", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d) => { err += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start: ${err}`)), 5000);
    child.stdout.on("data", (d) => { if (String(d).includes("listening")) { clearTimeout(t); resolve(); } });
    child.on("exit", (c) => { clearTimeout(t); reject(new Error(`server exited (${c}): ${err}`)); });
  });
  const url = `http://127.0.0.1:${port}`;
  return {
    url, dir, port,
    async stop({ keep = false } = {}) {
      child.kill();
      await new Promise((r) => child.once("exit", r));
      if (!keep) rmSync(dir, { recursive: true, force: true });
    },
  };
}
