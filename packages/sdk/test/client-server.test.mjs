// The client against the reference server: seats, send, idempotency, listen with resume after a restart, and the v0
// rank fix after the in-memory trim.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./helpers/server.mjs";
import { AgentComClient, AgentComError, request, reply, inform } from "../dist/index.js";
import { runConformance, formatReport } from "../dist/conformance/index.js";

let s;
const seat = async (url, address) => {
  const r = await fetch(`${url}/v1/seats`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) });
  assert.equal(r.status, 201);
  return r.json();
};
before(async () => { s = await startServer(); });
after(async () => { await s?.stop(); });

test("negotiate, send, receive by SSE, reply, resume after a reconnect", async () => {
  const a = await seat(s.url, "agent:teo.laptop");
  const b = await seat(s.url, "colleague:gaspard");
  assert.equal((await fetch(`${s.url}/v1/seats`, { method: "POST", body: JSON.stringify({ address: "colleague:gaspard" }) })).status, 409);
  const A = new AgentComClient({ baseUrl: s.url, token: a.token, address: a.address });
  const B = new AgentComClient({ baseUrl: s.url, token: () => b.token, address: b.address });
  const d = await A.negotiate();
  assert.deepEqual(d.conformance, [0, 1, 2, 3]);
  assert.ok(d.capabilities.includes("sse"));

  const got = [];
  const l = B.listen((m) => { got.push(m); }, { transport: "sse" });
  const q = await A.send(request(b.address, "Is the stage ready on Thursday?", { subject: "ticket:OOP-512", title: "Stage" }));
  assert.equal(q.created, true);
  assert.equal(q.thread.state, "sent");
  for (let i = 0; i < 50 && !got.length; i++) await new Promise((r) => setTimeout(r, 50));
  l.stop();
  assert.equal(got[0].id, q.message.id);
  assert.equal(got[0].from, "agent:teo.laptop");

  const r = await B.send(reply(got[0], "Yes, Thursday 9am."));
  assert.equal(r.thread.state, "replied");
  const box = await A.inbox({ after: 0 });
  assert.equal(box.messages.at(-1).text, "Yes, Thursday 9am.");

  /* Resume: messages sent while nobody listens arrive once, in order, after the stored cursor. */
  const cursor = l.cursor;
  await B.ack(cursor);
  for (const t of ["one", "two", "three"]) await A.send(inform(b.address, t));
  const again = [];
  const l2 = B.listen((m) => { again.push(m.text); }, { after: cursor, transport: "poll" });
  for (let i = 0; i < 50 && again.length < 3; i++) await new Promise((r) => setTimeout(r, 50));
  l2.stop();
  assert.deepEqual(again, ["one", "two", "three"]);
  const acked = (await B.inbox({ after: 0 })).acked_n;
  assert.ok(acked >= cursor + 3, `acked_n ${acked}`);
});

test("refusals come back as AgentComError with the protocol code", async () => {
  const a = await seat(s.url, "test:refusals-a");
  const A = new AgentComClient({ baseUrl: s.url, token: a.token, address: a.address });
  await assert.rejects(A.send(request("test:nobody-here", "hello?")), (e) => e instanceof AgentComError && e.code === "unknown_recipient" && e.status === 404);
  await assert.rejects(A.send({ cid: "x", to: "test:x", act: "inform", text: "y".repeat(4001) }), (e) => e.code === "text_too_long" && e.status === null);
  await assert.rejects(new AgentComClient({ baseUrl: s.url, address: a.address }).inbox(), (e) => e.code === "unauthenticated");
});

test("the server state survives a restart (one JSONL log), ranks continue", async () => {
  const s2 = await startServer();
  const a = await seat(s2.url, "test:persist-a");
  const b = await seat(s2.url, "test:persist-b");
  const A = () => new AgentComClient({ baseUrl: s2.url, token: a.token, address: a.address });
  const q = await A().send(request(b.address, "persist?"));
  await s2.stop({ keep: true });
  const s3 = await startServer({}, s2.dir);
  try {
    const A3 = new AgentComClient({ baseUrl: s3.url, token: a.token, address: a.address });
    const again = await A3.send({ ...request(b.address, "persist?"), cid: q.message.cid });
    assert.equal(again.created, false);
    assert.equal(again.message.id, q.message.id);
    const next = await A3.send(inform(b.address, "after restart"));
    assert.equal(next.message.n, q.message.n + 1);
    assert.equal((await A3.thread(q.message.thread)).thread.state, "sent");
  } finally {
    await s3.stop();
  }
});

test("v0 rooms: a rank is never handed out twice after the in-memory trim, nor after a restart", async () => {
  const s2 = await startServer({ AGENTCOM_MAX_MSGS: "5" });
  const post = async (url, room, text) => {
    const r = await fetch(`${url}/r/${room}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ as: "t", text }) });
    return (await r.json()).posted;
  };
  const { room } = await (await fetch(`${s2.url}/new.json`)).json();
  const ns = [];
  for (let i = 0; i < 9; i++) ns.push(await post(s2.url, room, `m${i}`));
  assert.deepEqual(ns, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  await s2.stop({ keep: true });
  const s3 = await startServer({ AGENTCOM_MAX_MSGS: "5" }, s2.dir);
  try {
    assert.equal(await post(s3.url, room, "after restart"), 10);
    const { messages } = await (await fetch(`${s3.url}/r/${room}.json?after=0`)).json();
    assert.deepEqual(messages.map((m) => m.n), [6, 7, 8, 9, 10]);
  } finally {
    await s3.stop();
  }
});

test("conformance: the reference server passes levels 0 to 3", async () => {
  const report = await runConformance({ baseUrl: s.url, claim: true });
  if (!report.ok) console.log(formatReport(report));
  assert.deepEqual(report.passed, [0, 1, 2, 3]);
  assert.equal(report.results.filter((r) => !r.ok).length, 0);
});

test("reserved spaces: open registration cannot claim nodal: or claude-code:", async () => {
  for (const address of ["nodal:gaspard", "claude-code:teo.laptop"]) {
    const r = await fetch(`${s.url}/v1/seats`, { method: "POST", body: JSON.stringify({ address }) });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error, "forbidden");
  }
  assert.deepEqual((await (await fetch(`${s.url}/.well-known/agentcom`)).json()).reserved_spaces, ["nodal", "claude-code"]);
});

test("a malformed percent-escape is a 400, never a crash", async () => {
  for (const p of ["/v1/mailbox/%E0", "/r/%E0", "/%"]) assert.equal((await fetch(`${s.url}${p}`)).status, 400);
  assert.equal((await fetch(`${s.url}/health`)).status, 200);
});

test("a torn last line (crash mid-append) is cut at start: no seat lost, no rank reused (v1 and v0)", async () => {
  const { appendFileSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const s2 = await startServer();
  const bob = await seat(s2.url, "torn:bob");
  const { room } = await (await fetch(`${s2.url}/new.json`)).json();
  const post0 = async (u) => (await (await fetch(`${u}/r/${room}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ as: "t", text: "x" }) })).json()).posted;
  assert.equal(await post0(s2.url), 1);
  await s2.stop({ keep: true });
  appendFileSync(join(s2.dir, "v1", "log.jsonl"), '{"type":"send","message":{"v":"agentcom/1-dr');
  appendFileSync(join(s2.dir, "rooms", `${room}.jsonl`), '{"n":2,"from":"t","te');
  let s3 = await startServer({}, s2.dir);
  const alice = await seat(s3.url, "torn:alice");
  const A3 = new AgentComClient({ baseUrl: s3.url, token: alice.token, address: alice.address });
  const m1 = await A3.send(request(bob.address, "q1"));
  assert.equal(m1.message.n, 1);
  assert.equal(await post0(s3.url), 2);
  await s3.stop({ keep: true });
  assert.ok(readFileSync(join(s2.dir, "v1", "log.jsonl"), "utf8").endsWith("\n"));
  s3 = await startServer({}, s2.dir);
  try {
    const A4 = new AgentComClient({ baseUrl: s3.url, token: alice.token, address: alice.address });
    assert.equal((await A4.send(request(bob.address, "q2"))).message.n, 2);   // alice's seat survived, n continues
    const steal = await fetch(`${s3.url}/v1/seats`, { method: "POST", body: JSON.stringify({ address: "torn:alice" }) });
    assert.equal(steal.status, 409);                                            // nobody can take it over
    assert.equal(await post0(s3.url), 3);
  } finally {
    await s3.stop();
  }
});

test("open streams are capped per seat (SSE and long-poll)", async () => {
  const s2 = await startServer({ AGENTCOM_MAX_STREAMS_PER_SEAT: "2" });
  try {
    const a = await seat(s2.url, "cap:a");
    const ctl = new AbortController();
    const open = () => fetch(`${s2.url}/v1/mailbox/cap:a/events`, { headers: { authorization: `Bearer ${a.token}` }, signal: ctl.signal });
    const r1 = await open(); const r2 = await open(); const r3 = await open();
    assert.deepEqual([r1.status, r2.status, r3.status], [200, 200, 429]);
    const poll = await fetch(`${s2.url}/v1/mailbox/cap:a?wait=2`, { headers: { authorization: `Bearer ${a.token}` } });
    assert.equal(poll.status, 429);
    ctl.abort();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await fetch(`${s2.url}/v1/mailbox/cap:a?wait=0`, { headers: { authorization: `Bearer ${a.token}` } })).status, 200);
  } finally {
    await s2.stop();
  }
});

test("retention: old messages leave memory and disk, ranks and seats stay", async () => {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const s2 = await startServer();
  const a = await seat(s2.url, "ret:a"); const b = await seat(s2.url, "ret:b");
  const A2 = new AgentComClient({ baseUrl: s2.url, token: a.token, address: a.address });
  await A2.send(inform(b.address, "old"));
  await s2.stop({ keep: true });
  const log = join(s2.dir, "v1", "log.jsonl");
  writeFileSync(log, readFileSync(log, "utf8").replace(/"at":"20\d\d-[^"]+"/g, '"at":"2020-01-01T00:00:00.000Z"'));
  const s3 = await startServer({}, s2.dir);
  try {
    assert.ok(!readFileSync(log, "utf8").includes('"text":"old"'));
    const B3 = new AgentComClient({ baseUrl: s3.url, token: b.token, address: b.address });
    assert.deepEqual((await B3.inbox()).messages, []);
    const A3 = new AgentComClient({ baseUrl: s3.url, token: a.token, address: a.address });
    assert.equal((await A3.send(inform(b.address, "new"))).message.n, 2);
  } finally {
    await s3.stop();
  }
});
