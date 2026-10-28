// The life of a thread: sent → auto_replied | awaiting_human → replied → closed, with a followups counter.
// Pure functions shared by clients (to predict and explain) and servers (to enforce). Same table as Ooper Relay.
import { AgentComError, type Act } from "./envelope.js";

export const THREAD_STATES = ["sent", "auto_replied", "awaiting_human", "replied", "closed"] as const;
export type ThreadState = (typeof THREAD_STATES)[number];

/** States still waiting for an answer: the only ones a follow-up may target. */
export const OPEN_STATES: readonly ThreadState[] = ["sent", "awaiting_human"];
/** The act that opened a thread. */
export const THREAD_KINDS = ["request", "propose", "inform"] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];
/** Only a request or a proposal waits for an answer, so only those are ever followed up. */
export const FOLLOWABLE_KINDS: readonly ThreadKind[] = ["request", "propose"];

/** A thread as a server returns it (GET /v1/threads/<id>). Implementations may add fields. */
export type Thread = {
  id: string;
  v?: string;
  kind: ThreadKind;
  requester: string;
  recipient: string;
  subject: string | null;
  title: string | null;
  state: ThreadState;
  human_asked: boolean;
  followups: number;
  last_followup_at?: string | null;
  due?: string | null;
  ext?: Record<string, Record<string, unknown>>;
  created_at: string;
  updated_at: string;
  last_activity_at?: string;
};

/** Allowed moves (a state may always stay itself). */
export const TRANSITIONS: Readonly<Record<ThreadState, readonly ThreadState[]>> = {
  sent: ["auto_replied", "awaiting_human", "replied", "closed"],
  awaiting_human: ["replied", "closed"],
  /* auto_replied → replied: the recipient's human corrects what its agent answered alone. */
  auto_replied: ["replied", "closed", "sent"],
  replied: ["closed", "sent"],
  closed: ["sent"],
};

export function transitionAllowed(from: ThreadState, to: ThreadState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/**
 * The state a thread takes when this act enters it (null: unchanged). An inform that opens a thread closes it at once;
 * a reply, accept or reject answers (auto_replied when the agent acted without its human); a follow-up only bumps the
 * counter.
 */
export function stateAfter(act: Act | string, auto: boolean, opening = false): ThreadState | null {
  switch (act) {
    case "request": case "propose": return "sent";
    case "inform": return opening ? "closed" : null;
    case "reply": case "accept": case "reject": return auto ? "auto_replied" : "replied";
    case "close": return "closed";
    default: return null;
  }
}

/** Is this reply/accept/reject marked as made by the agent alone (`ext.agentcom.auto`)? */
export function isAuto(ext: Record<string, Record<string, unknown>> | null | undefined): boolean {
  return ext?.agentcom?.auto === true;
}

export type Step = { state: ThreadState; followups: number };

/**
 * Applies one message to a thread and returns the new state and counter, or throws an AgentComError with the code a
 * server answers: `forbidden` (not an end, wrong recipient, follow-up by the recipient) or `invalid_transition`.
 * `thread` null means the message opens a new thread.
 */
export function applyMessage(thread: Pick<Thread, "state" | "followups" | "kind" | "requester" | "recipient"> | null, m: { act: string; from: string; to: string; auto?: boolean }): Step {
  if (!thread) {
    const s = stateAfter(m.act, !!m.auto, true);
    if (m.act !== "request" && m.act !== "propose" && m.act !== "inform") throw new AgentComError("invalid_envelope", `a "${m.act}" goes into an existing thread`);
    return { state: s ?? "sent", followups: 0 };
  }
  const other = thread.requester === m.from ? thread.recipient : thread.recipient === m.from ? thread.requester : null;
  if (!other) throw new AgentComError("forbidden", "This agent is not part of the thread.");
  if (m.to !== other) throw new AgentComError("forbidden", "In a thread, one writes to the other end only.");
  if (m.act === "followup") {
    if (thread.requester !== m.from) throw new AgentComError("forbidden", "Only the requester follows up.");
    if (!OPEN_STATES.includes(thread.state) || !FOLLOWABLE_KINDS.includes(thread.kind)) {
      throw new AgentComError("invalid_transition", `Nothing to follow up: only an open request or proposal (kind "${thread.kind}", state "${thread.state}").`);
    }
    return { state: thread.state, followups: thread.followups + 1 };
  }
  if ((m.act === "reply" || m.act === "accept" || m.act === "reject") && thread.recipient !== m.from) {
    throw new AgentComError("forbidden", `Only the recipient of the thread may send a "${m.act}".`);
  }
  if (m.act === "close" && thread.recipient === m.from && OPEN_STATES.includes(thread.state) && FOLLOWABLE_KINDS.includes(thread.kind)) {
    throw new AgentComError("invalid_transition", 'Closing an unanswered request needs a reason: send a "reject" with reason "closed_without_answer" instead.');
  }
  const next = stateAfter(m.act, !!m.auto, false);
  if (next && !transitionAllowed(thread.state, next)) throw new AgentComError("invalid_transition", `Transition refused: ${thread.state} → ${next}`);
  return { state: next ?? thread.state, followups: thread.followups };
}

/** The recipient hands the thread over to its human. Throws like `applyMessage`. */
export function applyAwaitingHuman(thread: Pick<Thread, "state" | "recipient">, by: string): ThreadState {
  if (thread.recipient !== by) throw new AgentComError("forbidden", "Only the recipient hands over to its human.");
  if (!transitionAllowed(thread.state, "awaiting_human")) throw new AgentComError("invalid_transition", `Transition refused: ${thread.state} → awaiting_human`);
  return "awaiting_human";
}
