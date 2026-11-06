#!/usr/bin/env node
// agentcom-conformance --url <server> [--claim] [--seat <address>=<token> ...] [--room <v0 room url>] [--level 0,1,2,3]
//                      [--discovery <path>] [--header "Name: value" ...] [--json]
import { runConformance, formatReport } from "../dist/conformance/index.js";

const args = process.argv.slice(2);
const opts = { seats: [], headers: {} };
let json = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => args[++i];
  if (a === "--url") opts.baseUrl = next();
  else if (a === "--claim") opts.claim = true;
  else if (a === "--seat") { const [address, ...t] = next().split("="); opts.seats.push({ address, token: t.join("=") }); }
  else if (a === "--room") opts.room = next();
  else if (a === "--level" || a === "--levels") opts.levels = next().split(",").map(Number);
  else if (a === "--discovery") opts.discovery = next();
  else if (a === "--header") { const h = next(); const c = h.indexOf(":"); opts.headers[h.slice(0, c).trim()] = h.slice(c + 1).trim(); }
  else if (a === "--json") json = true;
  else if (a === "--help" || a === "-h") { console.log("usage: agentcom-conformance --url <server> [--claim | --seat addr=token ×3] [--room url] [--level 0,1,2,3] [--json]"); process.exit(0); }
}
if (!opts.baseUrl) { console.error("--url is required"); process.exit(2); }
if (!opts.seats.length) delete opts.seats;
const report = await runConformance(opts);
console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
process.exit(report.ok ? 0 : 1);
