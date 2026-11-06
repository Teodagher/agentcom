// The HTTP client: send with POST (idempotent by cid), read one's mailbox by long-poll or SSE with resume after the
// cursor `n`, acknowledge, read a thread, hand a thread over to one's human. No dependency: global fetch.
import { AgentComError, SPEC_VERSION, isTooLong, normalizeEnvelope, validateDraft, validateEnvelope, type Draft, type Envelope } from "./envelope.js";
import { DEFAULT_ENDPOINTS, assertCompatible, type Discovery, type Endpoints } from "./capabilities.js";
import type { Thread } from "./state.js";
import { readSse } from "./sse.js";

export type TokenSource = string | null | undefined | (() => string | null | undefined | Promise<string | null | undefined>);

export type ClientOptions = {
  /** The server's origin, e.g. "https://agentcom.example.com" or "https://nodal.ooper.dev". */
  baseUrl: string;
  /** The seat's secret (seat-token) or an OIDC access token; a function is called before every request (refresh). */
  token?: TokenSource;
  /** This agent's address, used in mailbox paths. Some servers derive it from the token and ignore it. */
  address?: string;
  /** Path of the discovery document (default "/.well-known/agentcom"). */
  discovery?: string;
  /** Override endpoint templates (otherwise: discovery, then the v1 defaults). */
  endpoints?: Partial<Endpoints>;
  /** Extra headers on every request (e.g. an implementation's session header). */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
};

export type SendResult = { message: Envelope; thread: Thread | null; created: boolean };
/** `address`: the mailbox's address, when the server says it (servers that derive it from the token always do). */
export type InboxResult = { address: string | null; messages: Envelope[]; last_n: number | null; acked_n: number | null };

export type ListenOptions = {
  /** Start after this rank (default 0: everything still in the mailbox). */
  after?: number;
  /** "sse" (default when the server offers it), "poll" (long-poll), or "auto" (SSE, falling back to long-poll). */
  transport?: "sse" | "poll" | "auto";
  /** Acknowledge each message after the handler resolves (default true). */
  autoAck?: boolean;
  /** Called with every transport error before reconnecting. */
  onError?: (e: unknown) => void;
  /** Called when the cursor moves, to persist it (resume after a restart). */
  onCursor?: (n: number) => void;
  /** Delay before reconnecting, in ms (default 2000; doubles up to 30 s while failing). */
  retryMs?: number;
  signal?: AbortSignal;
};

export type Listener = { stop(): void; readonly cursor: number; done: Promise<void> };

/** A connection held at least this long counts as healthy (resets the backoff) even without events. */
const HELD_MS = 10_000;

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

export class AgentComClient {
  readonly baseUrl: string;
  address: string | null;
  endpoints: Endpoints;
  discovery: Discovery | null = null;
  private readonly opts: ClientOptions;
  private readonly f: typeof fetch;

  constructor(o: ClientOptions) {
    this.opts = o;
    this.baseUrl = o.baseUrl.replace(/\/+$/, "");
    this.address = o.address ?? null;
    this.endpoints = { ...DEFAULT_ENDPOINTS, ...(o.endpoints ?? {}) };
    this.f = o.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Reads the discovery document, checks the major version, and adopts the server's endpoints. */
  async negotiate(): Promise<Discovery> {
    const d = await this.call<Discovery>("GET", this.opts.discovery ?? "/.well-known/agentcom", undefined, { auth: false });
    assertCompatible(d);
    /* A discovery document never sends the client (and its token) to another origin: endpoints are absolute paths. */
    for (const [k, v] of Object.entries(d.endpoints ?? {})) {
      if (typeof v !== "string" || !v.startsWith("/") || v.startsWith("//") || /[\\\s]/.test(v)) {
        throw new AgentComError("forbidden", `The discovery document's endpoint "${k}" must be a path on ${this.baseUrl}, got ${JSON.stringify(v).slice(0, 80)}.`);
      }
    }
    this.discovery = d;
    this.endpoints = { ...DEFAULT_ENDPOINTS, ...(d.endpoints ?? {}), ...(this.opts.endpoints ?? {}) };
    return d;
  }

  /** Sends a draft. Validated locally first. 201: new message; 200: the same cid was already stored (nothing duplicated). */
  async send(draft: Draft): Promise<SendResult> {
    const problems = validateDraft(draft);
    if (problems.length) throw new AgentComError(isTooLong(problems) ? "text_too_long" : "invalid_envelope", problems.join("; "));
    const { body, status } = await this.callFull<{ message: Envelope; thread?: Thread | null }>("POST", this.endpoints.messages, draft);
    return { message: normalizeEnvelope(body.message as Envelope & Record<string, unknown>), thread: body.thread ?? null, created: status === 201 };
  }

  /** Reads the mailbox after rank `after`; with `wait` (seconds, 25 max) the server holds the call until something arrives. */
  async inbox(o: { after?: number; wait?: number; limit?: number; signal?: AbortSignal } = {}): Promise<InboxResult> {
    const q = new URLSearchParams({ after: String(o.after ?? 0) });
    if (o.wait) q.set("wait", String(o.wait));
    if (o.limit) q.set("limit", String(o.limit));
    const r = await this.call<{ address?: string; messages?: Envelope[]; last_n?: number; acked_n?: number }>("GET", `${this.path("mailbox")}?${q}`, undefined, { signal: o.signal });
    if (typeof r.address === "string" && !this.address) this.address = r.address;
    return {
      address: typeof r.address === "string" ? r.address : null,
      messages: (r.messages ?? []).filter((m) => validateEnvelope(m).length === 0).map((m) => normalizeEnvelope(m as Envelope & Record<string, unknown>)),
      last_n: typeof r.last_n === "number" ? r.last_n : null,
      acked_n: typeof r.acked_n === "number" ? r.acked_n : null,
    };
  }

  /** Acknowledges everything up to rank `n` (never backwards). */
  async ack(n: number): Promise<{ acked_n: number }> {
    return this.call("POST", this.path("ack"), { n });
  }

  /** A thread, its state and its messages (only its two ends may read it). */
  async thread(id: string): Promise<{ thread: Thread; messages: Envelope[] }> {
    const r = await this.call<{ thread: Thread; messages: Envelope[] }>("GET", this.path("thread", id));
    return { thread: r.thread, messages: (r.messages ?? []).map((m) => normalizeEnvelope(m as Envelope & Record<string, unknown>)) };
  }

  /** The recipient tells the requester it is asking its human (sent → awaiting_human). */
  async awaitHuman(thread: string): Promise<{ thread: Thread }> {
    return this.call("POST", this.path("awaiting_human", thread), {});
  }

  /**
   * One SSE connection to the mailbox, replaying everything after `after`. Ends when the server closes the stream.
   * Use `listen` for a connection that reconnects and resumes by itself.
   */
  async *events(o: { after?: number; signal?: AbortSignal } = {}): AsyncGenerator<Envelope> {
    const q = new URLSearchParams({ after: String(o.after ?? 0) });
    const res = await this.raw("GET", `${this.path("events")}?${q}`, undefined, { signal: o.signal, accept: "text/event-stream", lastEventId: o.after });
    if (!res.ok) throw await this.toError(res);
    /* A 200 that is not an event stream (a proxy page, JSON) is an error, not an empty stream to reconnect to at once. */
    if (!/^text\/event-stream/i.test(res.headers.get("content-type") ?? "")) {
      await res.body?.cancel().catch(() => {});
      throw new AgentComError("not_found", `The events endpoint did not answer with text/event-stream (${res.headers.get("content-type") ?? "no content type"}).`, 501);
    }
    if (!res.body) throw new AgentComError("not_found", "The server returned no event stream.", res.status);
    for await (const ev of readSse(res.body)) {
      if (ev.event !== "message" && ev.event !== "envelope") continue;
      let m: unknown;
      try { m = JSON.parse(ev.data); } catch { continue; }
      /* Only readable envelopes (a positive integer rank, addresses, thread…): never a NaN cursor. */
      if (validateEnvelope(m).length) continue;
      yield normalizeEnvelope(m as Envelope & Record<string, unknown>);
    }
  }

  /**
   * Listens to the mailbox for as long as `stop()` is not called: SSE (or long-poll), reconnecting with backoff and
   * resuming after the last rank handled, so nothing is lost and nothing is handled twice. A handler that throws stops
   * the cursor at that message: it is delivered again on the next connection.
   */
  listen(handler: (m: Envelope) => unknown | Promise<unknown>, o: ListenOptions = {}): Listener {
    const ctl = new AbortController();
    if (o.signal) o.signal.addEventListener("abort", () => ctl.abort(), { once: true });
    let cursor = o.after ?? 0;
    const autoAck = o.autoAck ?? true;
    const base = o.retryMs ?? 2000;
    let delay = base;
    let transport = o.transport ?? "auto";
    const handle = async (m: Envelope) => {
      if (!Number.isInteger(m.n) || m.n <= cursor) return;
      await handler(m);
      cursor = m.n;
      o.onCursor?.(cursor);
      if (autoAck) await this.ack(m.n).catch((e) => o.onError?.(e));
    };
    const loop = async () => {
      while (!ctl.signal.aborted) {
        try {
          /* Backoff resets only after a productive round: at least one event, or a connection held long enough. A
             server (or proxy) that answers at once with nothing would otherwise be hammered in a tight loop. */
          const started = Date.now();
          let got = 0;
          if (transport === "poll") {
            const r = await this.inbox({ after: cursor, wait: 25, signal: ctl.signal });
            for (const m of r.messages) { if (ctl.signal.aborted) return; got++; await handle(m); }
          } else {
            for await (const m of this.events({ after: cursor, signal: ctl.signal })) { if (ctl.signal.aborted) return; got++; await handle(m); }
          }
          if (got > 0 || Date.now() - started >= HELD_MS) { delay = base; if (transport !== "poll") await sleep(250, ctl.signal); }
          else { await sleep(delay, ctl.signal); delay = Math.min(delay * 2, 30_000); }
        } catch (e) {
          if (ctl.signal.aborted) return;
          /* A server without SSE (404/405/501): fall back to long-poll for good in "auto" mode. */
          if (transport === "auto" && e instanceof AgentComError && (e.status === 404 || e.status === 405 || e.status === 501)) { transport = "poll"; continue; }
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
  private path(name: keyof Endpoints, thread?: string): string {
    const t = this.endpoints[name];
    if (t.includes("{address}") && !this.address) throw new AgentComError("invalid_envelope", `This endpoint needs the client's address (${name}).`);
    return t.replace("{address}", encodeURIComponent(this.address ?? "")).replace("{thread}", encodeURIComponent(thread ?? ""));
  }

  private async token(): Promise<string | null> {
    const t = this.opts.token;
    return (typeof t === "function" ? await t() : t) ?? null;
  }

  private async raw(method: string, path: string, body?: unknown, o: { signal?: AbortSignal; accept?: string; auth?: boolean; lastEventId?: number } = {}): Promise<Response> {
    const headers: Record<string, string> = { accept: o.accept ?? "application/json", "agentcom-version": SPEC_VERSION, ...(this.opts.headers ?? {}) };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (o.auth !== false) { const t = await this.token(); if (t) headers.authorization = `Bearer ${t}`; }
    if (o.lastEventId) headers["last-event-id"] = String(o.lastEventId);
    return this.f(`${this.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: o.signal });
  }

  private async toError(res: Response): Promise<AgentComError> {
    const text = await res.text().catch(() => "");
    let j: { error?: string; message?: string; erreur?: string } | null = null;
    try { j = JSON.parse(text); } catch { /* plain text */ }
    const code = j?.error ?? ({ 400: "invalid_envelope", 401: "unauthenticated", 403: "forbidden", 404: "not_found", 409: "invalid_transition", 413: "text_too_long", 426: "unsupported_version", 429: "rate_limited" } as Record<number, string>)[res.status] ?? `http_${res.status}`;
    return new AgentComError(code, j?.message ?? j?.erreur ?? (text.trim() || `${res.status} ${res.statusText}`), res.status, j ?? text);
  }

  private async callFull<T>(method: string, path: string, body?: unknown, o: { signal?: AbortSignal; auth?: boolean } = {}): Promise<{ body: T; status: number }> {
    const res = await this.raw(method, path, body, o);
    if (!res.ok) throw await this.toError(res);
    return { body: (await res.json()) as T, status: res.status };
  }

  private async call<T>(method: string, path: string, body?: unknown, o: { signal?: AbortSignal; auth?: boolean } = {}): Promise<T> {
    return (await this.callFull<T>(method, path, body, o)).body;
  }
}
