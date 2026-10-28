// Runs the conformance suite against the reference server (server.js at the repository root) and prints the report.
import { startServer } from "./helpers/server.mjs";
import { runConformance, formatReport } from "../dist/conformance/index.js";

const s = await startServer();
try {
  const report = await runConformance({ baseUrl: s.url, claim: true });
  console.log(formatReport(report));
  process.exitCode = report.ok ? 0 : 1;
} finally {
  await s.stop();
}
