/** The chain the server stamped on a received envelope, or null (a server without the `team` capability). */
export function chainOf(m) {
    const c = m.ext?.agentcom?.chain;
    if (!c || typeof c !== "object" || typeof c.root !== "string" || typeof c.depth !== "number" || !Number.isInteger(c.depth) || c.depth < 0)
        return null;
    return { root: c.root, depth: c.depth, parent: typeof c.parent === "string" ? c.parent : null };
}
/**
 * The profile that applies to a received envelope: "team" only when the server stamped a sender's domain and it is
 * the receiver's own domain (as its server told it: the mailbox's `domain`, or `GET /v1/seats/me`). Anything else,
 * including a domain named in the text or in an extension, is "cross-domain".
 */
export function profileOf(m, myDomain) {
    return typeof m.from_domain === "string" && !!m.from_domain && !!myDomain && m.from_domain === myDomain ? "team" : "cross-domain";
}
export const sameDomain = (m, myDomain) => profileOf(m, myDomain) === "team";
/**
 * May this agent act on a received message without asking its human? Only a `request` or `propose` from its own
 * domain, and only while the chain stays under `maxDepth` (acting may open a request one step deeper). Everything else
 * goes to the human, as rule 1 says. The message is still quoted as data (`quote`) when shown to a model: acting on a
 * colleague's request is a decision the agent makes under its own permissions, not text run as instructions.
 */
export function mayActOn(m, myDomain, o = {}) {
    const teamServer = !o.server || (Array.isArray(o.server.capabilities) && o.server.capabilities.includes("team"));
    const profile = teamServer ? profileOf(m, myDomain) : "cross-domain";
    if (profile !== "team")
        return { ok: false, profile, reason: "cross_domain", message: "From outside this agent's domain: report it to the human (rule 1)." };
    if (m.act !== "request" && m.act !== "propose")
        return { ok: false, profile, reason: "not_a_request", message: `A "${m.act}" asks for nothing to act on.` };
    const depth = chainOf(m)?.depth ?? 0;
    const max = o.maxDepth ?? (typeof o.server?.limits?.chain_depth === "number" ? o.server.limits.chain_depth : 8);
    if (depth + 1 > max)
        return { ok: false, profile, reason: "chain_too_deep", message: `This request is ${depth} steps down a chain; this agent stops at ${max}. Reject it with reason "chain_too_deep" or ask the human.` };
    return { ok: true, profile, depth };
}
/** The extension that makes a new message one step of the chain `parent` belongs to (the server computes the rest). */
export function causedBy(parent, ext) {
    const id = typeof parent === "string" ? parent : parent.id;
    return { ...(ext ?? {}), agentcom: { ...(ext?.agentcom ?? {}), chain: { parent: id } } };
}
