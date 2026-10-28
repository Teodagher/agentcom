// One helper per act: they build a valid draft from what you have at hand (a received envelope, a thread id), so the
// threading fields (to, thread, in_reply_to) are always right. Nothing is sent here: pass the draft to `client.send`.
import type { Draft, Envelope, Ext, RejectReason } from "./envelope.js";

/** A fresh idempotency key. Keep it if you retry: the same cid never creates a second message. */
export function newCid(prefix = "c"): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  const id = g.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}:${id}`;
}

type Common = { cid?: string; ext?: Ext; ext_required?: string[] };
type Opening = Common & { subject?: string | null; title?: string | null; due?: string | null };
/** Where an answer goes: the envelope being answered (preferred), or the thread and the other end. */
type Target = Envelope | { thread: string; to: string; in_reply_to?: string | null };

const clean = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const target = (t: Target) => ("from" in t && "id" in t ? { to: t.from, thread: t.thread, in_reply_to: t.id } : { to: t.to, thread: t.thread, in_reply_to: t.in_reply_to ?? null });

function opener(act: "request" | "inform" | "propose", to: string, text: string, o: Opening = {}): Draft {
  return clean({ cid: o.cid ?? newCid(act), to, act, text, subject: o.subject, title: o.title, due: o.due, ext: o.ext, ext_required: o.ext_required });
}

/** Ask a question or for an action; an answer is expected. Opens a thread. */
export const request = (to: string, text: string, o?: Opening): Draft => opener("request", to, text, o);
/** Tell something; nothing is expected (the thread it opens is closed at once). */
export const inform = (to: string, text: string, o?: Opening): Draft => opener("inform", to, text, o);
/** Offer something to settle with accept or reject. Opens a thread. */
export const propose = (to: string, text: string, o?: Opening): Draft => opener("propose", to, text, o);

/** Answer a request. `auto`: your agent answered without its human (the thread becomes auto_replied). */
export function reply(to: Target, text: string, o: Common & { auto?: boolean } = {}): Draft {
  return clean({ cid: o.cid ?? newCid("reply"), ...target(to), act: "reply" as const, text, ext: withAuto(o.ext, o.auto), ext_required: o.ext_required });
}

/** Accept a proposal or a request for action. */
export function accept(to: Target, text = "Accepted.", o: Common & { auto?: boolean } = {}): Draft {
  return clean({ cid: o.cid ?? newCid("accept"), ...target(to), act: "accept" as const, text, ext: withAuto(o.ext, o.auto), ext_required: o.ext_required });
}

/** Refuse, with a reason code (core field `reason`). */
export function reject(to: Target, reason: RejectReason | string, text?: string, o: Common & { auto?: boolean } = {}): Draft {
  return clean({ cid: o.cid ?? newCid("reject"), ...target(to), act: "reject" as const, text: text ?? reason, reason, ext: withAuto(o.ext, o.auto), ext_required: o.ext_required });
}

/** Remind the recipient of an unanswered request or proposal (requester only; the state does not change). */
export function followup(thread: string, to: string, text: string, o: Common = {}): Draft {
  return clean({ cid: o.cid ?? newCid("followup"), to, thread, act: "followup" as const, text, ext: o.ext, ext_required: o.ext_required });
}

/** Close the thread. The recipient of an unanswered request must `reject` (closed_without_answer) instead. */
export function close(thread: string, to: string, text = "Closing this thread.", o: Common = {}): Draft {
  return clean({ cid: o.cid ?? newCid("close"), to, thread, act: "close" as const, text, ext: o.ext, ext_required: o.ext_required });
}

function withAuto(ext: Ext | undefined, auto: boolean | undefined): Ext | undefined {
  if (!auto) return ext;
  return { ...(ext ?? {}), agentcom: { ...(ext?.agentcom ?? {}), auto: true } };
}
