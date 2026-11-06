// 1.0.0-rc.2: trust domains, the team profile (chain depth, budgets) and the directory, against the reference server;
// and the SDK's team helpers on their own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./helpers/server.mjs";
import {
  AgentComClient, AgentComError, claimSeat, createDomain, request, reply, inform, validateDraft, normalizeEnvelope,
  chainOf, profileOf, mayActOn, causedBy, CORE_FIELDS, REJECT_REASONS, SPEC_VERSION,
} from "../dist/index.js";

const client = (url, seat) => new AgentComClient({ baseUrl: url, token: seat.token, address: seat.address });
const code = async (p) => { try { await p; } catch (e) { assert.ok(e instanceof AgentComError, String(e)); return `${e.status} ${e.code}`; } return "accepted"; };

test("SDK: version, core fields and reasons of 1.0.0-rc.2", () => {
  assert.equal(SPEC_VERSION, "1.0.0-rc.2");
  assert.ok(CORE_FIELDS.includes("from_domain"));
  assert.ok(REJECT_REASONS.includes("chain_too_deep"));
});

test("SDK: from_domain is never accepted in a draft; a chain parent must be a message id", () => {
  assert.match(validateDraft({ ...request("agent:b", "hi"), from_domain: "acme" }).join(), /from_domain/);
  assert.deepEqual(validateDraft(request("agent:b", "hi", { cause: "5b0c0000-0000-4000-8000-000000000001" })), []);
  assert.match(validateDraft(request("agent:b", "hi", { ext: { agentcom: { chain: { parent: "nope" } } } })).join(), /chain\.parent/);
  assert.match(validateDraft(request("agent:b", "hi", { ext: { agentcom: { chain: "x" } } })).join(), /chain/);
});

test("SDK: causedBy keeps the other extensions; normalizeEnvelope fills from_domain", () => {
  const ext = causedBy({ id: "p-1" }, { oopercast: { a: 1 }, agentcom: { auto: true } });
  assert.deepEqual(ext, { oopercast: { a: 1 }, agentcom: { auto: true, chain: { parent: "p-1" } } });
  assert.equal(normalizeEnvelope({ v: "agentcom/1-draft", id: "x", n: 1, from: "a:b", to: "c:d", act: "inform", thread: "t", text: "x", at: "2026-11-06T00:00:00Z" }).from_domain, null);
  assert.equal(normalizeEnvelope({ v: "agentcom/1-draft", id: "x", n: 1, from: "a:b", from_domain: "acme", to: "c:d", act: "inform", thread: "t", text: "x", at: "2026-11-06T00:00:00Z" }).from_domain, "acme");
});

test("SDK: profileOf and mayActOn only trust a stamped domain equal to one's own", () => {
  const m = (o) => ({ act: "request", from_domain: "acme", ext: { agentcom: { chain: { root: "r", depth: 0, parent: null } } }, ...o });
  assert.equal(profileOf(m(), "acme"), "team");
  assert.equal(profileOf(m(), "other"), "cross-domain");
  assert.equal(profileOf(m(), null), "cross-domain");
  assert.equal(profileOf(m({ from_domain: null }), null), "cross-domain");
  assert.equal(mayActOn(m(), "acme").ok, true);
  assert.equal(mayActOn(m(), "globex").reason, "cross_domain");
  assert.equal(mayActOn(m({ act: "inform" }), "acme").reason, "not_a_request");
  assert.equal(mayActOn(m({ ext: { agentcom: { chain: { root: "r", depth: 3, parent: "p" } } } }), "acme", { maxDepth: 3 }).reason, "chain_too_deep");
  assert.equal(mayActOn(m({ ext: { agentcom: { chain: { root: "r", depth: 2, parent: "p" } } } }), "acme", { maxDepth: 3 }).ok, true);
  assert.equal(chainOf({ ext: {} }), null);
  assert.equal(chainOf({ ext: { agentcom: { chain: { root: "r", depth: -1 } } } }), null);
});

test("domains: a key is needed to join; unknown domain 404; taken 409; seats/me cannot change the domain", async () => {
  const s = await startServer();
  try {
    const d = await createDomain(s.url, "acme");
    assert.match(d.key, /^ad_/);
    assert.equal(await code(createDomain(s.url, "acme")), "409 domain_taken");
    assert.equal(await code(createDomain(s.url, "Not A Domain")), "400 invalid_envelope");
    assert.equal(await code(claimSeat(s.url, { address: "agent:intruder", domain: "acme", domain_key: "ad_wrong" })), "403 forbidden");
    assert.equal(await code(claimSeat(s.url, { address: "agent:intruder", domain: "acme" })), "403 forbidden");
    assert.equal(await code(claimSeat(s.url, { address: "agent:lost", domain: "nowhere", domain_key: "x" })), "404 not_found");
    const a = await claimSeat(s.url, { address: "agent:designer", domain: "acme", domain_key: d.key, name: "Designer", description: "Draws the screens" });
    assert.equal(a.domain, "acme");
    const A = client(s.url, a);
    assert.deepEqual(await A.me(), { address: "agent:designer", domain: "acme", name: "Designer", description: "Draws the screens", claimed: (await A.me()).claimed });
    const moved = await fetch(`${s.url}/v1/seats/me`, { method: "POST", headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" }, body: JSON.stringify({ domain: "globex" }) });
    assert.equal(`${moved.status} ${(await moved.json()).error}`, "400 invalid_envelope");
    assert.equal((await A.me()).domain, "acme");
    assert.equal(await code(A.updateMe({ name: "x".repeat(81) })), "400 invalid_envelope");
    assert.equal((await A.updateMe({ description: null })).description, null);
    const disc = await A.negotiate();
    assert.equal(disc.version, "1.0.0-rc.2");
    assert.ok(disc.capabilities.includes("team") && disc.capabilities.includes("directory"));
    assert.equal(disc.endpoints.directory, "/v1/directory");
    assert.equal(typeof disc.limits.chain_depth, "number");
  } finally { await s.stop(); }
});

test("closed registration: creating a domain needs the administrator token", async () => {
  const s = await startServer({ AGENTCOM_SEATS: "closed", AGENTCOM_ADMIN_TOKEN: "admin-secret" });
  try {
    assert.equal(await code(createDomain(s.url, "acme")), "401 unauthenticated");
    const d = await createDomain(s.url, "acme", { adminToken: "admin-secret" });
    assert.equal(d.domain, "acme");
  } finally { await s.stop(); }
});

test("directory: own domain and domain-less named seats; never another domain, never unnamed seats, never oneself", async () => {
  const s = await startServer();
  try {
    const acme = await createDomain(s.url, "acme");
    const globex = await createDomain(s.url, "globex");
    const me = await claimSeat(s.url, { address: "agent:me", domain: "acme", domain_key: acme.key, name: "Me" });
    await claimSeat(s.url, { address: "agent:colleague", domain: "acme", domain_key: acme.key, name: "Colleague", description: "Writes the copy" });
    await claimSeat(s.url, { address: "agent:quiet", domain: "acme", domain_key: acme.key });
    await claimSeat(s.url, { address: "agent:rival", domain: "globex", domain_key: globex.key, name: "Rival" });
    await claimSeat(s.url, { address: "agent:public", name: "Public helper" });
    const M = client(s.url, me);
    const all = await M.directory();
    assert.deepEqual(all.map((e) => e.address).sort(), ["agent:colleague", "agent:public"]);
    const c = all.find((e) => e.address === "agent:colleague");
    assert.deepEqual({ ...c, status: undefined }, { address: "agent:colleague", name: "Colleague", description: "Writes the copy", status: undefined, domain: "acme" });
    assert.equal(c.status, "offline");
    assert.deepEqual((await M.directory({ q: "COPY" })).map((e) => e.address), ["agent:colleague"]);
    assert.deepEqual((await M.directory({ limit: 1 })).length, 1);
    // A domain-less seat sees the public phonebook only.
    const loner = await claimSeat(s.url, { address: "agent:loner", name: "Loner" });
    assert.deepEqual((await client(s.url, loner).directory()).map((e) => e.address), ["agent:public"]);
    assert.equal(await code(client(s.url, { address: "agent:public", token: "x" }).directory()), "401 unauthenticated");
    // A seat that just called counts as online.
    assert.equal((await client(s.url, loner).directory({ q: "public" }))[0].status, "offline");
    const colleague = await claimSeat(s.url, { address: "agent:busy", domain: "acme", domain_key: acme.key, name: "Busy" });
    await client(s.url, colleague).inbox();
    assert.equal((await M.directory({ q: "busy" }))[0].status, "online");
  } finally { await s.stop(); }
});

test("team profile: budgets per thread and per domain; chains everywhere; state survives a restart", async () => {
  const s = await startServer({ AGENTCOM_TEAM_THREAD_BUDGET: "4", AGENTCOM_TEAM_DAILY_BUDGET: "3", AGENTCOM_CHAIN_DEPTH: "20" });
  let s2;
  try {
    const d = await createDomain(s.url, "acme");
    const a = await claimSeat(s.url, { address: "agent:a", domain: "acme", domain_key: d.key, name: "A" });
    const b = await claimSeat(s.url, { address: "agent:b", domain: "acme", domain_key: d.key, name: "B" });
    const x = await claimSeat(s.url, { address: "agent:outsider" });
    const A = client(s.url, a), B = client(s.url, b), X = client(s.url, x);
    // Per-thread budget: 4 messages a day in a team thread.
    const q = (await A.send(request(b.address, "Thread budget"))).message;
    await B.send(reply(q, "one", { auto: true }));
    await A.send({ ...request(b.address, "two"), thread: q.thread });
    await B.send(reply(q, "three", { auto: true }));
    assert.equal(await code(A.send({ ...request(b.address, "four"), thread: q.thread })), "429 budget_exhausted");
    // Per-domain budget: 3 chained messages (depth ≥ 1) a day.
    let last = (await A.send(request(b.address, "Chain start"))).message;
    for (let i = 1; i <= 3; i++) {
      const from = i % 2 ? B : A;
      const to = i % 2 ? a.address : b.address;
      last = (await from.send(request(to, `step ${i}`, { cause: last }))).message;
      assert.equal(chainOf(last).depth, i);
    }
    assert.equal(await code(A.send(request(b.address, "step 4", { cause: last }))), "429 budget_exhausted");
    // A message nobody's request caused is not chained: still allowed.
    assert.equal((await A.send(inform(b.address, "FYI, by my person"))).created, true);
    // Cross-domain: no team budget, from_domain stamped (null here), the chain still counted and bounded.
    const out = (await X.send(request(a.address, "From outside"))).message;
    assert.equal(out.from_domain, null);
    assert.equal(chainOf(out).depth, 0);
    const back = (await A.send(request(x.address, "Asking back", { cause: out }))).message;
    assert.equal(back.from_domain, "acme");
    assert.equal(chainOf(back).depth, 1);
    assert.equal((await A.thread(back.thread)).thread.domain, null);
    // Restart: domains, seats, names and the day's budgets come back from the log.
    await s.stop({ keep: true });
    s2 = await startServer({ AGENTCOM_TEAM_THREAD_BUDGET: "4", AGENTCOM_TEAM_DAILY_BUDGET: "3", AGENTCOM_CHAIN_DEPTH: "20" }, s.dir);
    const A2 = client(s2.url, a), B2 = client(s2.url, b);
    assert.deepEqual({ ...(await A2.me()), claimed: 0 }, { address: "agent:a", domain: "acme", name: "A", description: null, claimed: 0 });
    assert.equal((await B2.inbox()).domain, "acme");
    assert.equal(await code(A2.send(request(b.address, "after restart", { cause: (await A2.inbox()).messages.at(-1) }))), "429 budget_exhausted");
    assert.deepEqual((await A2.directory()).map((e) => e.address), ["agent:b"]);
    assert.equal(await code(createDomain(s2.url, "acme")), "409 domain_taken");
  } finally { await (s2 ?? s).stop(); }
});

test("chain depth: past the server's limit → 409 chain_too_deep, nothing stored", async () => {
  const s = await startServer({ AGENTCOM_CHAIN_DEPTH: "2" });
  try {
    const d = await createDomain(s.url, "acme");
    const a = await claimSeat(s.url, { address: "agent:a", domain: "acme", domain_key: d.key });
    const b = await claimSeat(s.url, { address: "agent:b", domain: "acme", domain_key: d.key });
    const A = client(s.url, a), B = client(s.url, b);
    const m0 = (await A.send(request(b.address, "0"))).message;
    const m1 = (await B.send(request(a.address, "1", { cause: m0 }))).message;
    const m2 = (await A.send(request(b.address, "2", { cause: m1 }))).message;
    assert.equal(chainOf(m2).depth, 2);
    const before = (await A.inbox()).last_n;
    const draft = request(a.address, "3", { cause: m2 });
    assert.equal(await code(B.send(draft)), "409 chain_too_deep");
    assert.equal((await A.inbox()).last_n, before);
    // The same cid can be used again once the chain is cut (nothing was stored under it).
    assert.equal((await B.send({ ...draft, ext: {} })).created, true);
  } finally { await s.stop(); }
});

test("conformance: capability checks run, and all-skipped capabilities are not reported as passed", async () => {
  const { runConformance } = await import("../dist/conformance/index.js");
  const s = await startServer();
  try {
    const full = await runConformance({ baseUrl: s.url, claim: true, levels: [3] });
    assert.deepEqual(full.capabilities.passed.sort(), ["directory", "team"]);
    assert.equal(full.ok, true);
    const noTeam = await runConformance({ baseUrl: s.url, claim: true, levels: [3], capabilities: ["directory"] });
    assert.deepEqual(noTeam.capabilities.checked, ["directory"]);
    // Without team seats (claim off, seats given), the team checks are skipped and the capability is not proven.
    const seats = [];
    for (const x of ["p", "q", "r"]) seats.push(await claimSeat(s.url, { address: `conf:${x}` }));
    const skipped = await runConformance({ baseUrl: s.url, seats, levels: [3], capabilities: ["team"] });
    assert.deepEqual(skipped.capabilities.skipped, ["team"]);
    assert.deepEqual(skipped.capabilities.passed, []);
  } finally { await s.stop(); }
});
