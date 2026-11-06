// The client against misbehaving servers: no reconnect storm, no NaN cursor, no discovery that leaves the origin.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AgentComClient } from "../dist/index.js";

const serve = (handler) => new Promise((resolve) => { const srv = http.createServer(handler); srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` })); });

test("a server that answers at once with nothing is not hammered (poll and SSE back off)", async () => {
  let polls = 0, sse = 0;
  const { srv, url } = await serve((req, res) => {
    if (req.url.includes("/events")) { sse++; res.writeHead(200, { "content-type": "text/event-stream" }); return res.end(); }
    polls++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ address: "x:y", messages: [], last_n: 0, acked_n: 0 }));
  });
  const c = new AgentComClient({ baseUrl: url, address: "x:y", token: "t" });
  const l1 = c.listen(() => {}, { transport: "poll", retryMs: 200 }); await new Promise((r) => setTimeout(r, 2000)); l1.stop();
  const l2 = c.listen(() => {}, { transport: "sse", retryMs: 200 }); await new Promise((r) => setTimeout(r, 2000)); l2.stop();
  srv.close();
  assert.ok(polls <= 6, `${polls} polls in 2 s`);
  assert.ok(sse <= 6, `${sse} SSE reconnects in 2 s`);
});

test("a 200 that is not an event stream is an error (auto falls back to long-poll); unreadable envelopes never move the cursor", async () => {
  let polled = 0;
  const { srv, url } = await serve((req, res) => {
    if (req.url.includes("/events")) { res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>proxy</html>"); }
    polled++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ messages: polled === 1 ? [{ n: "x", act: "inform" }, { v: "agentcom/1-draft", id: "m", n: 3, cid: "c", from: "a:b", to: "x:y", act: "inform", thread: "t", text: "ok", at: "2026-10-28T00:00:00Z" }] : [] }));
  });
  const c = new AgentComClient({ baseUrl: url, address: "x:y", token: "t" });
  const errors = [];
  await assert.rejects(async () => { for await (const _ of c.events()) { /* nothing */ } }, (e) => e.status === 501);
  const got = [];
  const l = c.listen((m) => got.push(m.n), { transport: "auto", autoAck: false, onError: (e) => errors.push(e) });
  for (let i = 0; i < 40 && !got.length; i++) await new Promise((r) => setTimeout(r, 50));
  l.stop();
  srv.close();
  assert.deepEqual(got, [3]);
  assert.equal(l.cursor, 3);
});

test("discovery endpoints must stay on the server's origin", async () => {
  for (const bad of ["https://evil.example/collect", "//evil.example/x", "relative/path"]) {
    const { srv, url } = await serve((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ protocol: "agentcom", versions: ["agentcom/1-draft"], version: "1.0.0-rc.1", conformance: [], acts: [], capabilities: [], extensions: [], seat_modes: [], endpoints: { messages: bad } }));
    });
    await assert.rejects(new AgentComClient({ baseUrl: url }).negotiate(), (e) => e.code === "forbidden");
    srv.close();
  }
});

test("the plugin's vendored SDK is the package build", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = dirname(fileURLToPath(import.meta.url));
  const dist = join(here, "../dist"), vendor = join(here, "../../../plugin/vendor/agentcom");
  const built = readdirSync(dist).filter((f) => f.endsWith(".js")).sort();
  assert.deepEqual(readdirSync(vendor).filter((f) => f.endsWith(".js")).sort(), built);
  for (const f of built) assert.equal(readFileSync(join(vendor, f), "utf8"), readFileSync(join(dist, f), "utf8"), `${f} differs: run npm run vendor`);
});
