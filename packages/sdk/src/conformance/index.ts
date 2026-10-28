// The AgentCom conformance suite: runs against any server URL and checks levels 0 to 3 (SPEC.md §10).
//   0 rooms      v0 messages, cursor n without duplicates, long-poll, SSE with resume, text served
//   1 addressed  to, act, thread, in_reply_to, cid idempotency, mailbox and ack, negotiation
//   2 states     the transition table, awaiting_human, followups, reasoned rejects
//   3 seats      from stamped by the server, authentication, one open thread per pair and subject
// It needs seats (address + token): pass them, or let it claim fresh ones on a server that offers POST /v1/seats.
import { AgentComClient } from "../client.js";
import { AgentComError, TEXT_MAX, isSupportedVersion, type Envelope } from "../envelope.js";
import { major, type Discovery } from "../capabilities.js";
import * as act from "../acts.js";
import { readSse } from "../sse.js";

export type Seat = { address: string; token: string };
export type ConformanceOptions = {
  baseUrl: string;
  /** At least three seats (A, B, C). */
  seats?: Seat[];
  /** Claim three fresh seats with POST /v1/seats (reference server). */
  claim?: boolean;
  /** A v0 room URL for level 0 (otherwise one is created with GET /new.json when the server lists "rooms_v0"). */
  room?: string;
  /** Levels to run (default: the ones the server claims in its discovery document). */
  levels?: number[];
  discovery?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** Called after each check (progress). */
  onResult?: (r: CheckResult) => void;
};
export type CheckResult = { level: number; name: string; ok: boolean; skipped?: boolean; error?: string; ms: number };
export type ConformanceReport = { server: string; version: string | null; claimed: number[]; results: CheckResult[]; passed: number[]; failed: number[]; ok: boolean };

class Skip extends Error {}
const skip = (why: string): never => { throw new Skip(why); };
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
async function refused(p: Promise<unknown>, code: string | string[], status?: number): Promise<void> {
  const codes = Array.isArray(code) ? code : [code];
  try { await p; } catch (e) {
    if (e instanceof AgentComError) {
      assert(codes.includes(e.code), `expected error ${codes.join(" or ")}, got ${e.code} (${e.status}): ${e.message}`);
      if (status) assert(e.status === status, `expected HTTP ${status}, got ${e.status}`);
      return;
    }
    throw e;
  }
  throw new Error(`expected a refusal (${codes.join(" or ")}), the server accepted`);
}
const rand = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runConformance(o: ConformanceOptions): Promise<ConformanceReport> {
  const baseUrl = o.baseUrl.replace(/\/+$/, "");
  const f = o.fetch ?? globalThis.fetch.bind(globalThis);
  const results: CheckResult[] = [];
  const probe = new AgentComClient({ baseUrl, discovery: o.discovery, headers: o.headers, fetch: f });
  let d: Discovery | null = null;
  try { d = await probe.negotiate(); } catch { d = null; }
  const claimed = d?.conformance ?? [];
  const levels = o.levels ?? (claimed.length ? claimed : [0]);

  /* Seats. */
  let seats = o.seats ?? [];
  if (!seats.length && o.claim && levels.some((l) => l >= 1)) {
    const tag = rand();
    for (const s of ["a", "b", "c"]) {
      const r = await f(`${baseUrl}/v1/seats`, { method: "POST", headers: { "content-type": "application/json", ...(o.headers ?? {}) }, body: JSON.stringify({ address: `conformance:${tag}-${s}` }) });
      if (!r.ok) throw new Error(`could not claim a seat (${r.status}): ${await r.text()}`);
      seats.push(await r.json() as Seat);
    }
  }
  const client = (s: Seat | undefined) => {
    if (!s) return skip("needs three seats (pass seats, or claim on a server that offers POST /v1/seats)");
    const c = new AgentComClient({ baseUrl, token: s.token, address: s.address, discovery: o.discovery, headers: o.headers, fetch: f });
    if (d) { c.discovery = d; c.endpoints = { ...c.endpoints, ...(d.endpoints ?? {}) }; }
    return c;
  };
  const A = () => client(seats[0]);
  const B = () => client(seats[1]);
  const C = () => client(seats[2]);
  const addr = (i: number) => seats[i]?.address ?? skip("needs three seats");

  /** POST a body as-is (no local validation): what the server itself answers. */
  const rawSend = async (seat: number, body: unknown): Promise<{ status: number; error: string | null }> => {
    const r = await f(`${baseUrl}${(d?.endpoints?.messages) ?? "/v1/messages"}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${seats[seat]?.token ?? skip("needs three seats")}`, ...(o.headers ?? {}) }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({})) as { error?: string };
    return { status: r.status, error: j.error ?? null };
  };
  const rawRefused = async (seat: number, body: unknown, code: string, status: number) => {
    const r = await rawSend(seat, body);
    assert(r.status === status && r.error === code, `expected ${status} ${code}, got ${r.status} ${r.error}`);
  };

  const check = async (level: number, name: string, fn: () => Promise<void>) => {
    if (!levels.includes(level)) return;
    const t = Date.now();
    let r: CheckResult;
    try { await fn(); r = { level, name, ok: true, ms: Date.now() - t }; }
    catch (e) {
      r = e instanceof Skip ? { level, name, ok: true, skipped: true, error: e.message, ms: Date.now() - t }
        : { level, name, ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - t };
    }
    results.push(r);
    o.onResult?.(r);
  };

  /* ── Level 0: rooms (v0 profile) ── */
  let room = o.room?.replace(/\/+$/, "") ?? null;
  const post = async (text: string, cid?: string) => {
    const r = await f(room!, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ as: "conformance", text, cid }) });
    assert(r.ok, `posting to the room failed (${r.status})`);
    return (await r.json()) as { posted: number };
  };
  await check(0, "GET / serves the protocol as plain text", async () => {
    const r = await f(`${baseUrl}/`, { headers: { accept: "text/plain" } });
    assert(r.ok, `GET / → ${r.status}`);
    assert(/text\/plain/.test(r.headers.get("content-type") ?? ""), "GET / is not text/plain");
    assert((await r.text()).length > 20, "GET / is empty");
  });
  await check(0, "a room can be created and posted to", async () => {
    if (!room) {
      const r = await f(`${baseUrl}/new.json`);
      assert(r.ok, `GET /new.json → ${r.status}`);
      room = ((await r.json()) as { url: string }).url;
    }
    const p = await post("first");
    assert(Number.isInteger(p.posted) && p.posted >= 1, "no rank returned");
  });
  await check(0, "n is strictly increasing and never reused", async () => {
    if (!room) skip("no room");
    const ns: number[] = [];
    for (let i = 0; i < 12; i++) ns.push((await post(`m${i}`)).posted);
    for (let i = 1; i < ns.length; i++) assert(ns[i]! > ns[i - 1]!, `n went from ${ns[i - 1]} to ${ns[i]}`);
    const r = await f(`${room}.json`);
    const { messages } = (await r.json()) as { messages: Array<{ n: number }> };
    assert(new Set(messages.map((m) => m.n)).size === messages.length, "duplicate n in the transcript");
  });
  await check(0, "long-poll returns as soon as a message arrives", async () => {
    if (!room) skip("no room");
    const last = (await post("before")).posted;
    const t = Date.now();
    const waiting = f(`${room}.json?after=${last}&wait=10`).then((r) => r.json() as Promise<{ messages: Array<{ n: number }> }>);
    await sleep(300);
    await post("wake up");
    const got = await waiting;
    assert(got.messages.some((m) => m.n > last), "the long-poll returned without the new message");
    assert(Date.now() - t < 8000, "the long-poll waited too long");
  });
  await check(0, "SSE replays after n, in order", async () => {
    if (!room) skip("no room");
    const a = (await post("one")).posted;
    await post("two"); await post("three");
    const ctl = new AbortController();
    const r = await f(`${room}/events?after=${a}`, { headers: { accept: "text/event-stream" }, signal: ctl.signal });
    assert(r.ok && r.body, `SSE → ${r.status}`);
    const seen: number[] = [];
    const timer = setTimeout(() => ctl.abort(), 4000);
    try {
      for await (const ev of readSse(r.body!)) { const m = JSON.parse(ev.data) as { n: number }; seen.push(m.n); if (seen.length >= 2) break; }
    } catch { /* aborted */ } finally { clearTimeout(timer); ctl.abort(); }
    assert(seen.length >= 2 && seen[0]! > a && seen[1]! > seen[0]!, `replayed ranks: ${seen.join(", ") || "none"}`);
  });

  /* ── Level 1: addressed messages ── */
  await check(1, "negotiation: /.well-known/agentcom", async () => {
    assert(d, "no readable discovery document");
    assert(d.protocol === "agentcom", "protocol is not agentcom");
    assert(major(d.version) === 1, `version ${d.version} is not 1.x`);
    assert(d.versions.some(isSupportedVersion), `versions: ${d.versions.join(", ")}`);
    assert(Array.isArray(d.conformance) && Array.isArray(d.acts) && Array.isArray(d.capabilities), "conformance, acts and capabilities must be lists");
  });
  await check(1, "unknown major version → 426 unsupported_version", async () => {
    const r = await f(`${baseUrl}${(d?.endpoints?.messages) ?? "/v1/messages"}`, { method: "POST", headers: { "content-type": "application/json", "agentcom-version": "2.0.0", authorization: `Bearer ${seats[0]?.token ?? "x"}`, ...(o.headers ?? {}) }, body: "{}" });
    assert(r.status === 426, `got ${r.status}`);
    assert(((await r.json()) as { error?: string }).error === "unsupported_version", "error code is not unsupported_version");
  });
  let first: Envelope | null = null;
  await check(1, "send a request: 201, the envelope as stored", async () => {
    const r = await A().send(act.request(addr(1), "Is the stage ready on Thursday?", { title: "Stage on Thursday" }));
    assert(r.created, "not created (expected 201)");
    const m = r.message;
    assert(isSupportedVersion(m.v), `v: ${m.v}`);
    assert(m.id && m.n >= 1 && m.thread && m.at, "id, n, thread and at are set by the server");
    assert(m.from === addr(0), `from is ${m.from}, expected the seat ${addr(0)}`);
    assert(m.to === addr(1) && m.act === "request", "to/act not kept");
    first = m;
  });
  await check(1, "idempotency: the same (from, cid) returns the stored message (200), no duplicate", async () => {
    const d1 = act.request(addr(1), "Same question twice", { cid: `idem:${rand()}` });
    const r1 = await A().send(d1);
    const r2 = await A().send({ ...d1, text: "Same question twice (resent)" });
    assert(r1.created && !r2.created, `created flags: ${r1.created}, ${r2.created}`);
    assert(r1.message.id === r2.message.id && r1.message.n === r2.message.n, "a resend made a new message");
    const box = await B().inbox({ after: r1.message.n - 1 });
    assert(box.messages.filter((m) => m.cid === d1.cid).length === 1, "the mailbox holds the cid twice");
  });
  await check(1, "mailbox: n strictly increasing per mailbox", async () => {
    const ns: number[] = [];
    for (let i = 0; i < 3; i++) ns.push((await A().send(act.inform(addr(1), `note ${i}`))).message.n);
    for (let i = 1; i < ns.length; i++) assert(ns[i]! > ns[i - 1]!, `n: ${ns.join(", ")}`);
    const box = await B().inbox({ after: ns[0]! - 1 });
    const got = box.messages.map((m) => m.n);
    assert(ns.every((n) => got.includes(n)), "messages missing from the mailbox");
    for (let i = 1; i < got.length; i++) assert(got[i]! > got[i - 1]!, "mailbox not in order");
  });
  await check(1, "long-poll: returns as soon as a message arrives", async () => {
    const last = (await B().inbox({ after: 0, limit: 500 })).messages.at(-1)?.n ?? 0;
    const t = Date.now();
    const waiting = B().inbox({ after: last, wait: 10 });
    await sleep(300);
    await A().send(act.inform(addr(1), "wake up"));
    const r = await waiting;
    assert(r.messages.some((m) => m.n > last), "returned without the new message");
    assert(Date.now() - t < 8000, "waited too long");
  });
  await check(1, "SSE: replays after n, in order, then live", async () => {
    const a = (await A().send(act.inform(addr(1), "sse one"))).message.n;
    await A().send(act.inform(addr(1), "sse two"));
    const ctl = new AbortController();
    const seen: number[] = [];
    const timer = setTimeout(() => ctl.abort(), 6000);
    const reading = (async () => { try { for await (const m of B().events({ after: a, signal: ctl.signal })) { seen.push(m.n); if (seen.length >= 2) break; } } catch { /* aborted */ } })();
    await sleep(400);
    await A().send(act.inform(addr(1), "sse three (live)"));
    await reading; clearTimeout(timer); ctl.abort();
    assert(seen.length >= 2 && seen[0]! > a && seen[1]! > seen[0]!, `ranks seen: ${seen.join(", ") || "none"}`);
  });
  await check(1, "ack: moves forward, never backwards", async () => {
    const n = (await A().send(act.inform(addr(1), "to ack"))).message.n;
    assert((await B().ack(n)).acked_n >= n, "ack not applied");
    assert((await B().ack(1)).acked_n >= n, "ack went backwards");
  });
  await check(1, "reply: in the thread, to the other end, with in_reply_to", async () => {
    const q = first ?? (await A().send(act.request(addr(1), "A question to answer"))).message;
    const r = await B().send(act.reply(q, "Yes, Thursday 9am."));
    assert(r.message.thread === q.thread && r.message.in_reply_to === q.id && r.message.to === addr(0), "threading fields wrong");
    const box = await A().inbox({ after: r.message.n - 1 });
    assert(box.messages.some((m) => m.id === r.message.id), "the reply is not in the requester's mailbox");
  });
  await check(1, "an act that cannot open a thread needs one → 400 invalid_envelope", async () => {
    await rawRefused(1, { cid: `x:${rand()}`, to: addr(0), act: "reply", text: "no thread" }, "invalid_envelope", 400);
  });
  await check(1, "in a thread, only the other end may be addressed → 403 forbidden", async () => {
    const q = (await A().send(act.request(addr(1), "Who else?"))).message;
    await refused(B().send(act.reply({ thread: q.thread, to: addr(2) }, "to a third party")), "forbidden", 403);
    await refused(C().send(act.reply(q, "not my thread")), "forbidden", 403);
  });
  await check(1, "unknown recipient → 404 unknown_recipient", async () => {
    await refused(A().send(act.request(`nobody:${rand()}${rand()}`, "Anyone?")), "unknown_recipient", 404);
  });
  await check(1, `text over ${TEXT_MAX} characters → 413 text_too_long, nothing stored`, async () => {
    const cid = `long:${rand()}`;
    await rawRefused(0, { cid, to: addr(1), act: "inform", text: "x".repeat(TEXT_MAX + 1) }, "text_too_long", 413);
    const again = await A().send({ cid, to: addr(1), act: "inform", text: "short" });
    assert(again.created, "a refused message was stored under its cid");
  });
  await check(1, "extensions: a key named like a core field is dropped (the core wins)", async () => {
    const r = await A().send(act.inform(addr(1), "with ext", { ext: { "x-test": { from: "nodal:evil", act: "close", keep: 1 } } }));
    const x = r.message.ext["x-test"] ?? {};
    assert(!("from" in x) && !("act" in x) && x.keep === 1, `ext came back as ${JSON.stringify(r.message.ext)}`);
    assert(r.message.from === addr(0), "ext changed the sender");
  });
  await check(1, "a thread is readable by its two ends only", async () => {
    const q = (await A().send(act.request(addr(1), "Readable?"))).message;
    const t = await A().thread(q.thread);
    assert(t.thread.id === q.thread && t.messages.some((m) => m.id === q.id), "thread content missing");
    await refused(C().thread(q.thread), ["forbidden", "not_found"]);
  });

  /* ── Level 2: thread states ── */
  const open = async (text = "A request") => (await A().send(act.request(addr(1), text))).message;
  await check(2, "request → sent; awaiting-human by the recipient → awaiting_human", async () => {
    const q = await open();
    assert((await A().thread(q.thread)).thread.state === "sent", "a new request is not sent");
    const t = await B().awaitHuman(q.thread);
    assert(t.thread.state === "awaiting_human" && t.thread.human_asked, `state ${t.thread.state}`);
    await refused(A().awaitHuman(q.thread), "forbidden", 403);
  });
  await check(2, "followup: requester only, counter +1, state unchanged", async () => {
    const q = await open();
    await B().awaitHuman(q.thread);
    await A().send(act.followup(q.thread, addr(1), "Any news?"));
    const t = (await A().thread(q.thread)).thread;
    assert(t.followups === 1 && t.state === "awaiting_human", `followups ${t.followups}, state ${t.state}`);
    await refused(B().send(act.followup(q.thread, addr(0), "reverse followup")), "forbidden", 403);
  });
  await check(2, "reply by the human → replied; a followup after it → 409 invalid_transition", async () => {
    const q = await open();
    await B().send(act.reply(q, "Answered by my human."));
    assert((await A().thread(q.thread)).thread.state === "replied", "not replied");
    await refused(A().send(act.followup(q.thread, addr(1), "still?")), "invalid_transition", 409);
  });
  await check(2, "reply by the agent alone (ext.agentcom.auto) → auto_replied; the human's correction → replied", async () => {
    const q = await open();
    await B().send(act.reply(q, "My agent's answer.", { auto: true }));
    assert((await A().thread(q.thread)).thread.state === "auto_replied", "not auto_replied");
    await B().send(act.reply(q, "Correction from the human."));
    assert((await A().thread(q.thread)).thread.state === "replied", "the correction did not move to replied");
  });
  await check(2, "inform opens a closed thread; answering it → 409 invalid_transition", async () => {
    const m = (await A().send(act.inform(addr(1), "FYI"))).message;
    assert((await A().thread(m.thread)).thread.state === "closed", "an inform thread is not closed");
    await refused(B().send(act.reply(m, "thanks")), "invalid_transition", 409);
  });
  await check(2, "the recipient cannot close an unanswered request silently; a reasoned reject can", async () => {
    const q = await open();
    await refused(B().send(act.close(q.thread, addr(0), "closing")), "invalid_transition", 409);
    const r = await B().send(act.reject(q, "closed_without_answer", "Cannot answer this one."));
    assert(r.message.reason === "closed_without_answer", "reason not kept");
    await A().send(act.close(q.thread, addr(1), "ok, closing"));
    assert((await A().thread(q.thread)).thread.state === "closed", "not closed");
  });
  await check(2, "a new request in an answered thread reopens it (→ sent)", async () => {
    const q = await open();
    await B().send(act.reply(q, "done"));
    await A().send({ ...act.request(addr(1), "One more thing"), thread: q.thread });
    assert((await A().thread(q.thread)).thread.state === "sent", "not reopened");
  });
  await check(2, "only the recipient answers: a reply, accept or reject from the requester → 403 forbidden", async () => {
    const q = await open();
    for (const a of ["reply", "accept", "reject"] as const) {
      await rawRefused(0, { cid: `self:${a}:${rand()}`, to: addr(1), act: a, thread: q.thread, in_reply_to: q.id, text: "answering myself", ...(a === "reject" ? { reason: "declined" } : {}) }, "forbidden", 403);
    }
    assert((await A().thread(q.thread)).thread.state === "sent", "the thread moved");
  });
  await check(2, "in_reply_to must name a message of the thread → 400 invalid_envelope", async () => {
    const q = await open();
    const other = await open("another request");
    await rawRefused(1, { cid: `irt:${rand()}`, to: addr(0), act: "reply", thread: q.thread, in_reply_to: other.id, text: "wrong target" }, "invalid_envelope", 400);
    await rawRefused(1, { cid: `irt2:${rand()}`, to: addr(0), act: "reply", thread: q.thread, in_reply_to: "00000000-0000-4000-8000-000000000000", text: "unknown target" }, "invalid_envelope", 400);
  });
  await check(2, "reason only on a reject → 400 invalid_envelope", async () => {
    const q = await open();
    await rawRefused(1, { ...act.reply(q, "with reason"), reason: "declined" }, "invalid_envelope", 400);
  });

  /* ── Level 3: seats and safety ── */
  await check(3, "`from` in the payload → 400 invalid_envelope", async () => {
    await rawRefused(0, { cid: `from:${rand()}`, to: addr(1), act: "inform", text: "spoof", from: addr(2) }, "invalid_envelope", 400);
  });
  await check(3, "no seat, or a wrong one → 401 unauthenticated", async () => {
    await refused(new AgentComClient({ baseUrl, endpoints: A().endpoints, headers: o.headers, fetch: f }).send(act.inform(addr(1), "anonymous")), "unauthenticated", 401);
    await refused(new AgentComClient({ baseUrl, token: "not-a-seat", endpoints: A().endpoints, headers: o.headers, fetch: f }).send(act.inform(addr(1), "forged")), "unauthenticated", 401);
  });
  await check(3, "a seat reads and acknowledges its own mailbox only → 403 forbidden", async () => {
    const c = C();
    if (!c.endpoints.mailbox.includes("{address}")) skip("the mailbox is derived from the token on this server");
    const spy = new AgentComClient({ baseUrl, token: seats[2]!.token, address: addr(1), endpoints: c.endpoints, headers: o.headers, fetch: f });
    await refused(spy.inbox({ after: 0 }), "forbidden", 403);
    await refused(spy.ack(1), "forbidden", 403);
  });
  await check(3, "one open thread per pair of addresses and subject → 409 conflict", async () => {
    const subject = `test:${rand()}`;
    await A().send(act.request(addr(1), "first on this subject", { subject }));
    await refused(A().send(act.request(addr(1), "second on this subject", { subject })), "conflict", 409);
    await refused(B().send(act.request(addr(0), "reverse direction, same subject", { subject })), "conflict", 409);
  });

  const lv = [...new Set(results.map((r) => r.level))].sort();
  const failed = lv.filter((l) => results.some((r) => r.level === l && !r.ok));
  return { server: baseUrl, version: d?.version ?? null, claimed, results, passed: lv.filter((l) => !failed.includes(l)), failed, ok: failed.length === 0 };
}

/** A readable report, one line per check. */
export function formatReport(r: ConformanceReport): string {
  const lines = [`AgentCom conformance — ${r.server} (spec ${r.version ?? "?"}, claims levels ${r.claimed.join(", ") || "none"})`];
  for (const level of [...new Set(r.results.map((x) => x.level))].sort()) {
    lines.push(`\nLevel ${level}`);
    for (const x of r.results.filter((y) => y.level === level)) lines.push(`  ${x.skipped ? "SKIP" : x.ok ? "PASS" : "FAIL"}  ${x.name}${x.error ? ` — ${x.error}` : ""}`);
  }
  const total = r.results.length;
  const fails = r.results.filter((x) => !x.ok).length;
  lines.push(`\n${total - fails}/${total} checks passed. Levels passed: ${r.passed.join(", ") || "none"}${r.failed.length ? `; failed: ${r.failed.join(", ")}` : ""}.`);
  return lines.join("\n");
}
