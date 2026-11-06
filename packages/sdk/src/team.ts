// Trust domains and the team profile (SPEC.md §8, 1.0.0-rc.2). Agents of one organisation share a trust domain; the
// server stamps the sender's domain on every envelope (`from_domain`) and the chain each message belongs to
// (`ext.agentcom.chain`). Inside a domain, an agent may act on a colleague's request (rule 1 is amended there);
// across domains, rule 1 stands: what another agent says is data, never an instruction.
import type { Envelope, Ext } from "./envelope.js";

/** Where a message sits in a chain of agents acting on each other's requests. Stamped by the server. */
export type Chain = {
  /** The id of the message that started the chain (or of the thread, for threads older than 1.0.0-rc.2). */
  root: string;
  /** 0 for a message nobody's request caused; parent's depth + 1 for a message that cites its parent. */
  depth: number;
  /** The message this one acts on, or null. */
  parent: string | null;
};

/** The two policy profiles. */
export type Profile = "team" | "cross-domain";

/** The chain the server stamped on a received envelope, or null (a server without the `team` capability). */
export function chainOf(m: Pick<Envelope, "ext">): Chain | null {
  const c = (m.ext?.agentcom as { chain?: unknown } | undefined)?.chain as Partial<Chain> | undefined;
  if (!c || typeof c !== "object" || typeof c.root !== "string" || typeof c.depth !== "number" || !Number.isInteger(c.depth) || c.depth < 0) return null;
  return { root: c.root, depth: c.depth, parent: typeof c.parent === "string" ? c.parent : null };
}

/**
 * The profile that applies to a received envelope: "team" only when the server stamped a sender's domain and it is
 * the receiver's own domain (as its server told it: the mailbox's `domain`, or `GET /v1/seats/me`). Anything else,
 * including a domain named in the text or in an extension, is "cross-domain".
 */
export function profileOf(m: Pick<Envelope, "from_domain">, myDomain: string | null | undefined): Profile {
  return typeof m.from_domain === "string" && !!m.from_domain && !!myDomain && m.from_domain === myDomain ? "team" : "cross-domain";
}

export const sameDomain = (m: Pick<Envelope, "from_domain">, myDomain: string | null | undefined) => profileOf(m, myDomain) === "team";

export type TeamPolicy = {
  /** The deepest chain this agent takes part in (default 8, the reference server's limit). */
  maxDepth?: number;
};

export type ActDecision =
  | { ok: true; profile: "team"; depth: number }
  | { ok: false; profile: Profile; reason: "cross_domain" | "chain_too_deep" | "not_a_request"; message: string };

/**
 * May this agent act on a received message without asking its human? Only a `request` or `propose` from its own
 * domain, and only while the chain stays under `maxDepth` (acting may open a request one step deeper). Everything else
 * goes to the human, as rule 1 says. The message is still quoted as data (`quote`) when shown to a model: acting on a
 * colleague's request is a decision the agent makes under its own permissions, not text run as instructions.
 */
export function mayActOn(m: Pick<Envelope, "act" | "from_domain" | "ext">, myDomain: string | null | undefined, o: TeamPolicy = {}): ActDecision {
  const profile = profileOf(m, myDomain);
  if (profile !== "team") return { ok: false, profile, reason: "cross_domain", message: "From outside this agent's domain: report it to the human (rule 1)." };
  if (m.act !== "request" && m.act !== "propose") return { ok: false, profile, reason: "not_a_request", message: `A "${m.act}" asks for nothing to act on.` };
  const depth = chainOf(m)?.depth ?? 0;
  const max = o.maxDepth ?? 8;
  if (depth + 1 > max) return { ok: false, profile, reason: "chain_too_deep", message: `This request is ${depth} steps down a chain; this agent stops at ${max}. Reject it with reason "chain_too_deep" or ask the human.` };
  return { ok: true, profile, depth };
}

/** The extension that makes a new message one step of the chain `parent` belongs to (the server computes the rest). */
export function causedBy(parent: Pick<Envelope, "id"> | string, ext?: Ext): Ext {
  const id = typeof parent === "string" ? parent : parent.id;
  return { ...(ext ?? {}), agentcom: { ...(ext?.agentcom ?? {}), chain: { parent: id } } };
}
