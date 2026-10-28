// The HTTP client: send with POST (idempotent by cid), read one's mailbox by long-poll or SSE with resume after the
// cursor `n`, acknowledge, read a thread, hand a thread over to one's human. No dependency: global fetch.
import { AgentComError, SPEC_VERSION, isTooLong, normalizeEnvelope, validateDraft } from "./envelope.js";
import { DEFAULT_ENDPOINTS, assertCompatible } from "./capabilities.js";
import { readSse } from "./sse.js";
const sleep = (ms, signal) => new Promise((resolve) => {
    if (signal?.aborted)
        return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});
export class AgentComClient {
    baseUrl;
    address;
    endpoints;
    discovery = null;
    opts;
    f;
    constructor(o) {
        this.opts = o;
        this.baseUrl = o.baseUrl.replace(/\/+$/, "");
        this.address = o.address ?? null;
        this.endpoints = { ...DEFAULT_ENDPOINTS, ...(o.endpoints ?? {}) };
        this.f = o.fetch ?? globalThis.fetch.bind(globalThis);
    }
    /** Reads the discovery document, checks the major version, and adopts the server's endpoints. */
    async negotiate() {
        const d = await this.call("GET", this.opts.discovery ?? "/.well-known/agentcom", undefined, { auth: false });
        assertCompatible(d);
        this.discovery = d;
        this.endpoints = { ...DEFAULT_ENDPOINTS, ...(d.endpoints ?? {}), ...(this.opts.endpoints ?? {}) };
        return d;
    }
    /** Sends a draft. Validated locally first. 201: new message; 200: the same cid was already stored (nothing duplicated). */
    async send(draft) {
        const problems = validateDraft(draft);
        if (problems.length)
            throw new AgentComError(isTooLong(problems) ? "text_too_long" : "invalid_envelope", problems.join("; "));
        const { body, status } = await this.callFull("POST", this.endpoints.messages, draft);
        return { message: normalizeEnvelope(body.message), thread: body.thread ?? null, created: status === 201 };
    }
    /** Reads the mailbox after rank `after`; with `wait` (seconds, 25 max) the server holds the call until something arrives. */
    async inbox(o = {}) {
        const q = new URLSearchParams({ after: String(o.after ?? 0) });
        if (o.wait)
            q.set("wait", String(o.wait));
        if (o.limit)
            q.set("limit", String(o.limit));
        const r = await this.call("GET", `${this.path("mailbox")}?${q}`, undefined, { signal: o.signal });
        if (typeof r.address === "string" && !this.address)
            this.address = r.address;
        return {
            address: typeof r.address === "string" ? r.address : null,
            messages: (r.messages ?? []).map((m) => normalizeEnvelope(m)),
            last_n: typeof r.last_n === "number" ? r.last_n : null,
            acked_n: typeof r.acked_n === "number" ? r.acked_n : null,
        };
    }
    /** Acknowledges everything up to rank `n` (never backwards). */
    async ack(n) {
        return this.call("POST", this.path("ack"), { n });
    }
    /** A thread, its state and its messages (only its two ends may read it). */
    async thread(id) {
        const r = await this.call("GET", this.path("thread", id));
        return { thread: r.thread, messages: (r.messages ?? []).map((m) => normalizeEnvelope(m)) };
    }
    /** The recipient tells the requester it is asking its human (sent → awaiting_human). */
    async awaitHuman(thread) {
        return this.call("POST", this.path("awaiting_human", thread), {});
    }
    /**
     * One SSE connection to the mailbox, replaying everything after `after`. Ends when the server closes the stream.
     * Use `listen` for a connection that reconnects and resumes by itself.
     */
    async *events(o = {}) {
        const q = new URLSearchParams({ after: String(o.after ?? 0) });
        const res = await this.raw("GET", `${this.path("events")}?${q}`, undefined, { signal: o.signal, accept: "text/event-stream", lastEventId: o.after });
        if (!res.ok)
            throw await this.toError(res);
        if (!res.body)
            throw new AgentComError("not_found", "The server returned no event stream.", res.status);
        for await (const ev of readSse(res.body)) {
            if (ev.event !== "message" && ev.event !== "envelope")
                continue;
            let m;
            try {
                m = JSON.parse(ev.data);
            }
            catch {
                continue;
            }
            if (m && typeof m === "object" && typeof m.n === "number")
                yield normalizeEnvelope(m);
        }
    }
    /**
     * Listens to the mailbox for as long as `stop()` is not called: SSE (or long-poll), reconnecting with backoff and
     * resuming after the last rank handled, so nothing is lost and nothing is handled twice. A handler that throws stops
     * the cursor at that message: it is delivered again on the next connection.
     */
    listen(handler, o = {}) {
        const ctl = new AbortController();
        if (o.signal)
            o.signal.addEventListener("abort", () => ctl.abort(), { once: true });
        let cursor = o.after ?? 0;
        const autoAck = o.autoAck ?? true;
        const base = o.retryMs ?? 2000;
        let delay = base;
        let transport = o.transport ?? "auto";
        const handle = async (m) => {
            if (m.n <= cursor)
                return;
            await handler(m);
            cursor = m.n;
            o.onCursor?.(cursor);
            if (autoAck)
                await this.ack(m.n).catch((e) => o.onError?.(e));
        };
        const loop = async () => {
            while (!ctl.signal.aborted) {
                try {
                    if (transport === "poll") {
                        const r = await this.inbox({ after: cursor, wait: 25, signal: ctl.signal });
                        for (const m of r.messages) {
                            if (ctl.signal.aborted)
                                return;
                            await handle(m);
                        }
                    }
                    else {
                        for await (const m of this.events({ after: cursor, signal: ctl.signal })) {
                            if (ctl.signal.aborted)
                                return;
                            await handle(m);
                        }
                    }
                    delay = base;
                    if (transport !== "poll")
                        await sleep(250, ctl.signal); // the server closed the stream: reconnect promptly
                }
                catch (e) {
                    if (ctl.signal.aborted)
                        return;
                    /* A server without SSE (404/405/501): fall back to long-poll for good in "auto" mode. */
                    if (transport === "auto" && e instanceof AgentComError && (e.status === 404 || e.status === 405 || e.status === 501)) {
                        transport = "poll";
                        continue;
                    }
                    o.onError?.(e);
                    await sleep(delay, ctl.signal);
                    delay = Math.min(delay * 2, 30_000);
                }
            }
        };
        const done = loop();
        return { stop: () => ctl.abort(), get cursor() { return cursor; }, done };
    }
    /* ── plumbing ── */
    path(name, thread) {
        const t = this.endpoints[name];
        if (t.includes("{address}") && !this.address)
            throw new AgentComError("invalid_envelope", `This endpoint needs the client's address (${name}).`);
        return t.replace("{address}", encodeURIComponent(this.address ?? "")).replace("{thread}", encodeURIComponent(thread ?? ""));
    }
    async token() {
        const t = this.opts.token;
        return (typeof t === "function" ? await t() : t) ?? null;
    }
    async raw(method, path, body, o = {}) {
        const headers = { accept: o.accept ?? "application/json", "agentcom-version": SPEC_VERSION, ...(this.opts.headers ?? {}) };
        if (body !== undefined)
            headers["content-type"] = "application/json";
        if (o.auth !== false) {
            const t = await this.token();
            if (t)
                headers.authorization = `Bearer ${t}`;
        }
        if (o.lastEventId)
            headers["last-event-id"] = String(o.lastEventId);
        return this.f(`${this.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: o.signal });
    }
    async toError(res) {
        const text = await res.text().catch(() => "");
        let j = null;
        try {
            j = JSON.parse(text);
        }
        catch { /* plain text */ }
        const code = j?.error ?? { 400: "invalid_envelope", 401: "unauthenticated", 403: "forbidden", 404: "not_found", 409: "invalid_transition", 413: "text_too_long", 426: "unsupported_version", 429: "rate_limited" }[res.status] ?? `http_${res.status}`;
        return new AgentComError(code, j?.message ?? j?.erreur ?? (text.trim() || `${res.status} ${res.statusText}`), res.status, j ?? text);
    }
    async callFull(method, path, body, o = {}) {
        const res = await this.raw(method, path, body, o);
        if (!res.ok)
            throw await this.toError(res);
        return { body: (await res.json()), status: res.status };
    }
    async call(method, path, body, o = {}) {
        return (await this.callFull(method, path, body, o)).body;
    }
}
