import { test } from "node:test";
import assert from "node:assert/strict";
import * as A from "../dist/index.js";

const thread = "9e1a0d5c-3b1f-4c55-8a3e-1d2f3a4b5c6d";

test("a well-formed request passes; from in the payload never does", () => {
  assert.deepEqual(A.validateDraft({ cid: "c1", to: "nodal:u_42", act: "request", text: "Stage ready Thursday?", subject: "ticket:OOP-512", title: "Stage" }), []);
  assert.match(A.validateDraft({ cid: "c1", to: "nodal:u_42", act: "request", text: "x", from: "nodal:u_17" }).join(), /`from` is never declared/);
});

test("validation messages match Ooper Relay", () => {
  const e = A.validateDraft({ cid: "", to: "Nodal:x", act: "shout", text: "", thread: "nope", subject: "no space", title: "t".repeat(81), due: "tomorrow", reason: "Bad Reason", ext_required: ["Ok!"], ext: { "Bad NS": [] } });
  for (const m of ["cid expected (1 to 200 characters)", "unreadable recipient address", "unknown act", "empty text", "unreadable thread", 'subject: a "space:id" key', "title: 80 characters max", "due: an ISO date", "reason: a snake_case code", "reason: only on a reject", "ext_required: a list of namespaces", 'ext: unreadable namespace "Bad NS"', "ext.Bad NS: an object"]) {
    assert.ok(e.includes(m), `missing: ${m}\n${e.join("\n")}`);
  }
});

test("acts that cannot open a thread need one", () => {
  for (const act of ["reply", "accept", "reject", "followup", "close"]) assert.match(A.validateDraft({ cid: "c", to: "a:b", act, text: "x" }).join(), /goes into an existing thread/);
  for (const act of ["request", "inform", "propose"]) assert.deepEqual(A.validateDraft({ cid: "c", to: "a:b", act, text: "x" }), []);
});

test("text is limited to 4000 characters, never truncated", () => {
  const p = A.validateDraft({ cid: "c", to: "a:b", act: "inform", text: "x".repeat(4001) });
  assert.deepEqual(p, ["text too long (4000 max)"]);
  assert.equal(A.isTooLong(p), true);
  assert.deepEqual(A.validateDraft({ cid: "c", to: "a:b", act: "inform", text: "x".repeat(4000) }), []);
});

test("addresses", () => {
  assert.ok(A.isAddress("claude-code:u_17.laptop-main"));
  assert.ok(A.isAddress("nodal:4f2@x.y"));
  assert.ok(!A.isAddress("Nodal:x") && !A.isAddress("nodal:") && !A.isAddress("nodal:a b"));
  assert.deepEqual(A.parseAddress("claude-code:u_17.s1"), { space: "claude-code", id: "u_17.s1" });
  assert.throws(() => A.address("bad space", "x"));
});

test("the core wins over extensions", () => {
  assert.deepEqual(A.stripCoreFromExt({ oopercast: { from: "evil", ticket: 3 }, x: { act: "close" } }), { oopercast: { ticket: 3 }, x: {} });
});

test("received envelopes: versions, tolerance for unknown acts, defaults", () => {
  const m = { v: "agentcom/1-draft", id: "m1", n: 3, cid: "c", from: "a:b", to: "c:d", act: "negotiate", thread, text: "hi", at: "2026-10-28T09:12:44Z" };
  assert.deepEqual(A.validateEnvelope(m), []);
  assert.match(A.validateEnvelope({ ...m, v: "agentcom/2" }).join(), /unsupported version/);
  assert.ok(A.isSupportedVersion("agentcom/1") && A.isSupportedVersion("agentcom/1-draft") && !A.isSupportedVersion("agentcom/10"));
  const n = A.normalizeEnvelope(m);
  assert.equal(n.in_reply_to, null);
  assert.deepEqual(n.ext_required, []);
  assert.deepEqual(n.ext, {});
});

test("error codes carry their HTTP status", () => {
  assert.equal(A.ERROR_STATUS.text_too_long, 413);
  assert.equal(A.ERROR_STATUS.unsupported_version, 426);
  assert.equal(A.ERROR_STATUS.invalid_transition, 409);
});
