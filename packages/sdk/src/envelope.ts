// The AgentCom v1 envelope: what one agent sends another, and the rules a draft must pass before a server accepts it.
// Pure and dependency-free. Wire-compatible with Ooper Relay (briques/relay/src/envelope.ts), the first production
// implementation: same field names, same limits, same validation messages.

/** The wire version carried in `v` during the 1.0.0 release candidates. 1.0.0 final switches to "agentcom/1". */
export const VERSION = "agentcom/1-draft";
/** Every `v` value a v1 receiver must accept (same major). */
export const SUPPORTED_VERSIONS = ["agentcom/1-draft", "agentcom/1"] as const;
/** The semver of the specification this SDK implements (sent in the AgentCom-Version header). */
export const SPEC_VERSION = "1.0.0-rc.1";
export const PROTOCOL = "agentcom";

export const ACTS = ["request", "reply", "inform", "propose", "accept", "reject", "followup", "close"] as const;
export type Act = (typeof ACTS)[number];
/** Acts that may open a new thread (no `thread` in the draft). */
export const OPENERS: readonly Act[] = ["request", "inform", "propose"];

/** Standard reject reasons (the core field `reason`, only on a `reject`). Implementations may add their own snake_case codes. */
export const REJECT_REASONS = ["declined", "closed_without_answer", "act_not_understood", "ext_not_understood", "quota"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const TEXT_MAX = 4000;
export const TITLE_MAX = 80;
export const CID_MAX = 200;
export const EXT_MAX = 8000;

/** Extension namespaces reserved by the protocol itself. */
export const RESERVED_NAMESPACES = ["agentcom", "relay"] as const;

/* ── Addresses ── */
/** "<space>:<id>", e.g. "nodal:u_17" or "claude-code:u_17.laptop-main". */
export const ADDRESS_PATTERN = /^([a-z][a-z0-9_-]{0,30}):([A-Za-z0-9._@-]{1,128})$/;

export function isAddress(a: unknown): a is string {
  return typeof a === "string" && ADDRESS_PATTERN.test(a);
}

/** The space and id of an address, or null when it is not one. */
export function parseAddress(a: string): { space: string; id: string } | null {
  const m = ADDRESS_PATTERN.exec(a);
  return m ? { space: m[1]!, id: m[2]! } : null;
}

/** Builds an address and checks it. */
export function address(space: string, id: string): string {
  const a = `${space}:${id}`;
  if (!isAddress(a)) throw new TypeError(`Not an AgentCom address: ${a}`);
  return a;
}

/* ── The envelope ── */
/** Extensions: one object per namespace. */
export type Ext = Record<string, Record<string, unknown>>;

/** What a sender provides. There is no `from`: the server stamps it from the authenticated seat. */
export type Draft = {
  cid: string;
  to: string;
  act: Act;
  text: string;
  thread?: string | null;
  in_reply_to?: string | null;
  subject?: string | null;
  title?: string | null;
  due?: string | null;
  ext?: Ext;
  ext_required?: string[];
  reason?: string | null;
};

/** A message as a mailbox returns it. `act` is a string on the wire: a newer minor version may carry an act this SDK does not know. */
export type Envelope = {
  v: string;
  id: string;
  n: number;
  cid: string;
  from: string;
  to: string;
  act: Act;
  thread: string;
  in_reply_to: string | null;
  subject: string | null;
  title: string | null;
  text: string;
  due: string | null;
  ext: Ext;
  ext_required: string[];
  reason: string | null;
  at: string;
};

/** The core fields. An extension key that reuses one of these names is dropped: the core wins. */
export const CORE_FIELDS = ["v", "id", "n", "cid", "from", "to", "act", "thread", "in_reply_to", "subject", "title", "text", "due", "ext", "ext_required", "reason", "at"] as const;

export function stripCoreFromExt(ext: Ext | null | undefined): Ext {
  const out: Ext = {};
  for (const [k, v] of Object.entries(ext ?? {})) {
    out[k] = Object.fromEntries(Object.entries(v ?? {}).filter(([f]) => !(CORE_FIELDS as readonly string[]).includes(f)));
  }
  return out;
}

const SUBJECT = /^[a-z][a-z0-9_-]*:[^\s]{1,200}$/i;
export const EXT_NAMESPACE = /^[a-z][a-z0-9_.-]{0,40}$/;
const UUID = /^[0-9a-f-]{36}$/i;
const REASON = /^[a-z][a-z0-9_]{0,60}$/;

export function isAct(a: unknown): a is Act {
  return typeof a === "string" && (ACTS as readonly string[]).includes(a);
}

/** True for a `v` this SDK can read (major version 1). */
export function isSupportedVersion(v: unknown): boolean {
  return typeof v === "string" && /^agentcom\/1(?:$|[-.])/.test(v);
}

/**
 * Validates a draft. Returns the list of problems (empty: it may be sent). Rejects a `from` slipped into the payload,
 * an unknown act, an unreadable address, an empty or oversized text, a missing thread for an act that cannot open one,
 * and extensions without a namespace.
 */
export function validateDraft(d: unknown): string[] {
  const e: string[] = [];
  if (!d || typeof d !== "object" || Array.isArray(d)) return ["unreadable draft"];
  const x = d as Record<string, unknown>;
  if ("from" in x) e.push("`from` is never declared: the host stamps it");
  if (typeof x.cid !== "string" || !x.cid.trim() || x.cid.length > CID_MAX) e.push(`cid expected (1 to ${CID_MAX} characters)`);
  if (!isAddress(x.to)) e.push("unreadable recipient address");
  if (!isAct(x.act)) e.push("unknown act");
  if (typeof x.text !== "string" || !x.text.trim()) e.push("empty text");
  else if (x.text.length > TEXT_MAX) e.push(`text too long (${TEXT_MAX} max)`);
  if (x.thread == null && typeof x.act === "string" && !(OPENERS as readonly string[]).includes(x.act)) e.push(`a "${x.act}" goes into an existing thread`);
  if (x.thread != null && (typeof x.thread !== "string" || !UUID.test(x.thread))) e.push("unreadable thread");
  if (x.in_reply_to != null && (typeof x.in_reply_to !== "string" || !UUID.test(x.in_reply_to))) e.push("unreadable in_reply_to");
  if (x.subject != null && (typeof x.subject !== "string" || !SUBJECT.test(x.subject))) e.push('subject: a "space:id" key');
  if (x.title != null && (typeof x.title !== "string" || x.title.length > TITLE_MAX)) e.push(`title: ${TITLE_MAX} characters max`);
  if (x.due != null && (typeof x.due !== "string" || Number.isNaN(Date.parse(x.due)))) e.push("due: an ISO date");
  if (x.reason != null && (typeof x.reason !== "string" || !REASON.test(x.reason))) e.push("reason: a snake_case code");
  if (x.reason != null && x.act !== "reject") e.push("reason: only on a reject");
  if (x.ext_required != null && (!Array.isArray(x.ext_required) || x.ext_required.some((k) => typeof k !== "string" || !EXT_NAMESPACE.test(k)))) e.push("ext_required: a list of namespaces");
  if (x.ext != null) {
    if (typeof x.ext !== "object" || Array.isArray(x.ext)) e.push("ext: one object per namespace");
    else {
      for (const [k, v] of Object.entries(x.ext as Record<string, unknown>)) {
        if (!EXT_NAMESPACE.test(k)) e.push(`ext: unreadable namespace "${k}"`);
        if (!v || typeof v !== "object" || Array.isArray(v)) e.push(`ext.${k}: an object`);
      }
      if (JSON.stringify(x.ext).length > EXT_MAX) e.push(`ext: ${EXT_MAX} characters max`);
    }
  }
  return e;
}

/** True when a draft's only problem is its length: the server answers 413 text_too_long rather than 400. */
export function isTooLong(problems: string[]): boolean {
  return problems.length > 0 && problems.every((p) => p.startsWith("text too long"));
}

/**
 * Checks an envelope received from a server. Returns the problems (empty: readable). Tolerant on purpose: an unknown
 * act or extra fields are NOT problems (a newer minor version may send them; see `autoResponse`).
 */
export function validateEnvelope(m: unknown): string[] {
  const e: string[] = [];
  if (!m || typeof m !== "object" || Array.isArray(m)) return ["unreadable envelope"];
  const x = m as Record<string, unknown>;
  if (!isSupportedVersion(x.v)) e.push(`unsupported version: ${String(x.v)}`);
  if (typeof x.id !== "string" || !x.id) e.push("id expected");
  if (typeof x.n !== "number" || !Number.isInteger(x.n) || x.n < 1) e.push("n: a positive integer");
  if (typeof x.cid !== "string" || !x.cid) e.push("cid expected");
  if (!isAddress(x.from)) e.push("unreadable from");
  if (!isAddress(x.to)) e.push("unreadable to");
  if (typeof x.act !== "string" || !x.act) e.push("act expected");
  if (typeof x.thread !== "string" || !x.thread) e.push("thread expected");
  if (typeof x.text !== "string") e.push("text expected");
  if (typeof x.at !== "string" || Number.isNaN(Date.parse(x.at))) e.push("at: an ISO date");
  return e;
}

/** Fills the optional fields of a received envelope with their defaults (null, {}, []), and drops ext keys that shadow core fields. */
export function normalizeEnvelope(m: Partial<Envelope> & Record<string, unknown>): Envelope {
  return {
    v: String(m.v ?? VERSION), id: String(m.id), n: Number(m.n), cid: String(m.cid ?? ""), from: String(m.from), to: String(m.to),
    act: m.act as Act, thread: String(m.thread), in_reply_to: m.in_reply_to ?? null, subject: m.subject ?? null, title: m.title ?? null,
    text: String(m.text ?? ""), due: m.due ?? null, ext: stripCoreFromExt((m.ext as Ext) ?? {}),
    ext_required: Array.isArray(m.ext_required) ? m.ext_required.map(String) : [], reason: m.reason ?? null, at: String(m.at),
  };
}

/* ── Errors ── */
/** The error codes of the protocol, with their HTTP status. */
export const ERROR_STATUS = {
  invalid_envelope: 400,
  unauthenticated: 401,
  forbidden: 403,
  unknown_recipient: 404,
  not_found: 404,
  invalid_transition: 409,
  conflict: 409,
  seat_taken: 409,
  text_too_long: 413,
  unsupported_version: 426,
  rate_limited: 429,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;

/** A refusal from a server ({"error", "message"}), or a local validation failure. */
export class AgentComError extends Error {
  constructor(readonly code: ErrorCode | string, message: string, readonly status: number | null = null, readonly body: unknown = null) {
    super(message);
    this.name = "AgentComError";
  }
}
