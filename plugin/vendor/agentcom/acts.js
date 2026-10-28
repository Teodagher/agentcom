/** A fresh idempotency key. Keep it if you retry: the same cid never creates a second message. */
export function newCid(prefix = "c") {
    const g = globalThis;
    const id = g.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    return `${prefix}:${id}`;
}
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const target = (t) => ("from" in t && "id" in t ? { to: t.from, thread: t.thread, in_reply_to: t.id } : { to: t.to, thread: t.thread, in_reply_to: t.in_reply_to ?? null });
function opener(act, to, text, o = {}) {
    return clean({ cid: o.cid ?? newCid(act), to, act, text, subject: o.subject, title: o.title, due: o.due, ext: o.ext, ext_required: o.ext_required });
}
/** Ask a question or for an action; an answer is expected. Opens a thread. */
export const request = (to, text, o) => opener("request", to, text, o);
/** Tell something; nothing is expected (the thread it opens is closed at once). */
export const inform = (to, text, o) => opener("inform", to, text, o);
/** Offer something to settle with accept or reject. Opens a thread. */
export const propose = (to, text, o) => opener("propose", to, text, o);
/** Answer a request. `auto`: your agent answered without its human (the thread becomes auto_replied). */
export function reply(to, text, o = {}) {
    return clean({ cid: o.cid ?? newCid("reply"), ...target(to), act: "reply", text, ext: withAuto(o.ext, o.auto), ext_required: o.ext_required });
}
/** Accept a proposal or a request for action. */
export function accept(to, text = "Accepted.", o = {}) {
    return clean({ cid: o.cid ?? newCid("accept"), ...target(to), act: "accept", text, ext: withAuto(o.ext, o.auto), ext_required: o.ext_required });
}
/** Refuse, with a reason code (core field `reason`). */
export function reject(to, reason, text, o = {}) {
    return clean({ cid: o.cid ?? newCid("reject"), ...target(to), act: "reject", text: text ?? reason, reason, ext: withAuto(o.ext, o.auto), ext_required: o.ext_required });
}
/** Remind the recipient of an unanswered request or proposal (requester only; the state does not change). */
export function followup(thread, to, text, o = {}) {
    return clean({ cid: o.cid ?? newCid("followup"), to, thread, act: "followup", text, ext: o.ext, ext_required: o.ext_required });
}
/** Close the thread. The recipient of an unanswered request must `reject` (closed_without_answer) instead. */
export function close(thread, to, text = "Closing this thread.", o = {}) {
    return clean({ cid: o.cid ?? newCid("close"), to, thread, act: "close", text, ext: o.ext, ext_required: o.ext_required });
}
function withAuto(ext, auto) {
    if (!auto)
        return ext;
    return { ...(ext ?? {}), agentcom: { ...(ext?.agentcom ?? {}), auto: true } };
}
