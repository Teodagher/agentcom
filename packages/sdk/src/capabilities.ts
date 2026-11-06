// Capability negotiation (GET /.well-known/agentcom) and what a receiver does with what it does not understand:
// an unknown act gets a reject "act_not_understood"; a required extension it does not know gets "ext_not_understood".
import { ACTS, AgentComError, SPEC_VERSION, isAct, isSupportedVersion, type Draft, type Envelope } from "./envelope.js";
import { reject } from "./acts.js";

/** The endpoints of a server, as path templates. `{address}` and `{thread}` are replaced (URL-encoded). */
export type Endpoints = {
  messages: string;
  mailbox: string;
  events: string;
  ack: string;
  thread: string;
  awaiting_human: string;
};

export const DEFAULT_ENDPOINTS: Endpoints = {
  messages: "/v1/messages",
  mailbox: "/v1/mailbox/{address}",
  events: "/v1/mailbox/{address}/events",
  ack: "/v1/mailbox/{address}/ack",
  thread: "/v1/threads/{thread}",
  awaiting_human: "/v1/threads/{thread}/awaiting-human",
};

export const SEAT_MODES = ["host", "seat-token", "oidc", "none"] as const;
export type SeatMode = (typeof SEAT_MODES)[number];

/** The discovery document. Unknown fields are kept and ignored. */
export type Discovery = {
  protocol: "agentcom";
  /** Wire versions accepted in `v`, e.g. ["agentcom/1-draft"]. */
  versions: string[];
  /** Semver of the spec the server implements, e.g. "1.0.0-rc.1". */
  version: string;
  /** Conformance levels claimed, cumulative (0 to 3). */
  conformance: number[];
  acts: string[];
  capabilities: string[];
  /** Extension namespaces the server itself understands. */
  extensions: string[];
  seat_modes: SeatMode[] | string[];
  limits?: { text?: number; ext?: number; wait?: number; title?: number };
  endpoints?: Partial<Endpoints>;
  deprecated?: string[];
  [k: string]: unknown;
};

/** Major version of a semver string ("1.2.0-rc.1" → 1). */
export function major(semver: string): number {
  const m = /^(\d+)\./.exec(semver);
  return m ? Number(m[1]) : Number.NaN;
}

/** Throws `unsupported_version` unless the server speaks the same major version as this SDK. */
export function assertCompatible(d: Discovery): void {
  if (d.protocol !== "agentcom") throw new AgentComError("unsupported_version", `Not an AgentCom server (protocol: ${String(d.protocol)}).`);
  const wire = Array.isArray(d.versions) && d.versions.some(isSupportedVersion);
  if (!wire || major(String(d.version ?? "")) !== major(SPEC_VERSION)) {
    throw new AgentComError("unsupported_version", `Server speaks ${String(d.version)} (${(d.versions ?? []).join(", ")}); this SDK speaks ${SPEC_VERSION}.`);
  }
}

export const supports = (d: Discovery, capability: string) => Array.isArray(d.capabilities) && d.capabilities.includes(capability);

/** The extension namespaces an envelope requires and the receiver does not understand. */
export function missingExtensions(m: Pick<Envelope, "ext_required">, understood: readonly string[]): string[] {
  return (m.ext_required ?? []).filter((k) => !understood.includes(k));
}

export type AutoResponseOptions = {
  /** Extension namespaces this receiver understands (e.g. ["oopercast"]). */
  extensions?: readonly string[];
  /** Acts this receiver handles; default: every v1 act. */
  acts?: readonly string[];
};

/**
 * What a receiver must answer by itself, before any model sees the message, or null when the message is for it:
 * - an act it does not know → reject "act_not_understood";
 * - a request or proposal that requires an extension it does not understand → reject "ext_not_understood";
 * - any other message that requires an unknown extension is ignored (returns { ignore: true }).
 * Never answers an answer: a reject, reply, accept, close or followup it cannot read is ignored, not rejected (no loops).
 */
export function autoResponse(m: Envelope, o: AutoResponseOptions = {}): { draft: Draft } | { ignore: true } | null {
  const known = o.acts ?? ACTS;
  if (!known.includes(m.act)) {
    if (!isAct(m.act) || m.act === "request" || m.act === "propose") {
      return { draft: reject(m, "act_not_understood", `This agent does not understand the act "${m.act}".`, { cid: `auto-reject:${m.id}`, auto: true }) };
    }
    return { ignore: true };
  }
  const missing = missingExtensions(m, o.extensions ?? []);
  if (missing.length) {
    if (m.act === "request" || m.act === "propose") {
      return { draft: reject(m, "ext_not_understood", `This agent does not understand the required extension(s): ${missing.join(", ")}.`, { cid: `auto-reject:${m.id}`, auto: true }) };
    }
    return { ignore: true };
  }
  return null;
}
