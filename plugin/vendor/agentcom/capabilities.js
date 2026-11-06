// Capability negotiation (GET /.well-known/agentcom) and what a receiver does with what it does not understand:
// an unknown act gets a reject "act_not_understood"; a required extension it does not know gets "ext_not_understood".
import { ACTS, AgentComError, SPEC_VERSION, isAct, isSupportedVersion } from "./envelope.js";
import { reject } from "./acts.js";
export const DEFAULT_ENDPOINTS = {
    messages: "/v1/messages",
    mailbox: "/v1/mailbox/{address}",
    events: "/v1/mailbox/{address}/events",
    ack: "/v1/mailbox/{address}/ack",
    thread: "/v1/threads/{thread}",
    awaiting_human: "/v1/threads/{thread}/awaiting-human",
};
export const SEAT_MODES = ["host", "seat-token", "oidc", "none"];
/** Major version of a semver string ("1.2.0-rc.1" → 1). */
export function major(semver) {
    const m = /^(\d+)\./.exec(semver);
    return m ? Number(m[1]) : Number.NaN;
}
/** Throws `unsupported_version` unless the server speaks the same major version as this SDK. */
export function assertCompatible(d) {
    if (d.protocol !== "agentcom")
        throw new AgentComError("unsupported_version", `Not an AgentCom server (protocol: ${String(d.protocol)}).`);
    const wire = Array.isArray(d.versions) && d.versions.some(isSupportedVersion);
    if (!wire || major(String(d.version ?? "")) !== major(SPEC_VERSION)) {
        throw new AgentComError("unsupported_version", `Server speaks ${String(d.version)} (${(d.versions ?? []).join(", ")}); this SDK speaks ${SPEC_VERSION}.`);
    }
}
export const supports = (d, capability) => Array.isArray(d.capabilities) && d.capabilities.includes(capability);
/** The extension namespaces an envelope requires and the receiver does not understand. */
export function missingExtensions(m, understood) {
    return (m.ext_required ?? []).filter((k) => !understood.includes(k));
}
/**
 * What a receiver must answer by itself, before any model sees the message, or null when the message is for it:
 * - an act it does not know → reject "act_not_understood";
 * - a request or proposal that requires an extension it does not understand → reject "ext_not_understood";
 * - any other message that requires an unknown extension is ignored (returns { ignore: true }).
 * Never answers an answer: a reject, reply, accept, close or followup it cannot read is ignored, not rejected (no loops).
 */
export function autoResponse(m, o = {}) {
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
