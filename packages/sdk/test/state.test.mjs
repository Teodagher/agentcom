import { test } from "node:test";
import assert from "node:assert/strict";
import * as A from "../dist/index.js";

const T = (o = {}) => ({ state: "sent", followups: 0, kind: "request", requester: "a:1", recipient: "b:2", ...o });

test("the transition table (same as Ooper Relay)", () => {
  assert.ok(A.transitionAllowed("sent", "awaiting_human"));
  assert.ok(A.transitionAllowed("auto_replied", "replied"));
  assert.ok(A.transitionAllowed("closed", "sent"));
  assert.ok(!A.transitionAllowed("awaiting_human", "auto_replied"));
  assert.ok(!A.transitionAllowed("closed", "replied"));
  assert.ok(A.transitionAllowed("replied", "replied"));
});

test("stateAfter", () => {
  assert.equal(A.stateAfter("request", false), "sent");
  assert.equal(A.stateAfter("inform", false, true), "closed");
  assert.equal(A.stateAfter("inform", false, false), null);
  assert.equal(A.stateAfter("reply", true), "auto_replied");
  assert.equal(A.stateAfter("reject", false), "replied");
  assert.equal(A.stateAfter("followup", false), null);
  assert.equal(A.stateAfter("close", false), "closed");
});

test("applyMessage: opening, answering, correcting, reopening", () => {
  assert.deepEqual(A.applyMessage(null, { act: "request", from: "a:1", to: "b:2" }), { state: "sent", followups: 0 });
  assert.deepEqual(A.applyMessage(null, { act: "inform", from: "a:1", to: "b:2" }), { state: "closed", followups: 0 });
  assert.equal(A.applyMessage(T(), { act: "reply", from: "b:2", to: "a:1", auto: true }).state, "auto_replied");
  assert.equal(A.applyMessage(T({ state: "auto_replied" }), { act: "reply", from: "b:2", to: "a:1" }).state, "replied");
  assert.equal(A.applyMessage(T({ state: "replied" }), { act: "request", from: "a:1", to: "b:2" }).state, "sent");
});

test("applyMessage: followups count, never move the state, requester only", () => {
  assert.deepEqual(A.applyMessage(T({ state: "awaiting_human", followups: 1 }), { act: "followup", from: "a:1", to: "b:2" }), { state: "awaiting_human", followups: 2 });
  assert.throws(() => A.applyMessage(T(), { act: "followup", from: "b:2", to: "a:1" }), (e) => e.code === "forbidden");
  assert.throws(() => A.applyMessage(T({ state: "replied" }), { act: "followup", from: "a:1", to: "b:2" }), (e) => e.code === "invalid_transition");
  assert.throws(() => A.applyMessage(T({ kind: "inform", state: "sent" }), { act: "followup", from: "a:1", to: "b:2" }), (e) => e.code === "invalid_transition");
});

test("applyMessage: ends of the thread only, to the other end only", () => {
  assert.throws(() => A.applyMessage(T(), { act: "reply", from: "c:3", to: "a:1" }), (e) => e.code === "forbidden");
  assert.throws(() => A.applyMessage(T(), { act: "reply", from: "b:2", to: "c:3" }), (e) => e.code === "forbidden");
  assert.throws(() => A.applyMessage(T({ state: "closed" }), { act: "reply", from: "b:2", to: "a:1" }), (e) => e.code === "invalid_transition");
});

test("the recipient never closes an unanswered request silently", () => {
  assert.throws(() => A.applyMessage(T(), { act: "close", from: "b:2", to: "a:1" }), (e) => e.code === "invalid_transition" && /closed_without_answer/.test(e.message));
  assert.equal(A.applyMessage(T(), { act: "close", from: "a:1", to: "b:2" }).state, "closed");
  assert.equal(A.applyMessage(T({ state: "replied" }), { act: "close", from: "b:2", to: "a:1" }).state, "closed");
});

test("awaiting_human: recipient only", () => {
  assert.equal(A.applyAwaitingHuman(T(), "b:2"), "awaiting_human");
  assert.throws(() => A.applyAwaitingHuman(T(), "a:1"), (e) => e.code === "forbidden");
  assert.throws(() => A.applyAwaitingHuman(T({ state: "replied" }), "b:2"), (e) => e.code === "invalid_transition");
});
