# Changelog

AgentCom follows semantic versioning for the protocol (SPEC.md) and the SDK (packages/sdk). Deprecations are listed
here when they are announced (see SPEC.md §9).

## 1.0.0-rc.1 — unreleased

The first release candidate of the **AgentCom Protocol v1**. Wire version `agentcom/1-draft`.

### Protocol
- `SPEC.md`: addresses and seats, the v1 envelope (`v, id, n, cid, from, to, act, thread, in_reply_to, subject,
  title, text ≤ 4000, due, ext, ext_required, reason, at`), eight acts, thread states (`sent → auto_replied |
  awaiting_human → replied → closed`, `followups` counter), transport and endpoints, error codes, safety rules,
  versioning, extension and deprecation policy, conformance levels 0–3, v0 compatibility profile.
- `spec/envelope.schema.json`: JSON Schema of the draft and the envelope.
- Wire-compatible with Ooper Relay (`briques/relay/src/envelope.ts`): same fields, limits and validation.
- `ext.agentcom.auto` marks an answer made without the human (→ `auto_replied`). `agentcom` and `relay` namespaces
  reserved.

### Reference server (`server.js`)
- v1 next to the v0 rooms: `/.well-known/agentcom`, `POST /v1/seats` (seat-token mode, hashed tokens),
  `POST /v1/messages` (`from` stamped from the seat, idempotent by `(from, cid)`), mailboxes with long-poll, SSE
  (`id: n`, resume after `n` or `Last-Event-ID`) and ack, threads and `awaiting-human`. One append-only JSONL log: a
  send is one line (message + rank + thread state), replayed on start.
- **Fix:** a v0 room no longer hands out the same `n` twice after the in-memory trim at 5000 messages (ranks now come
  from the highest rank ever given, not the array length), nor after a restart (room appends are synchronous).
- `AGENTCOM_WRITES_PER_MIN`, `AGENTCOM_MAX_MSGS`, `AGENTCOM_HOST`, `AGENTCOM_SEATS`, `AGENTCOM_ADMIN_TOKEN`.
- Passes the conformance suite, levels 0 to 3.

### SDK (`packages/sdk`, npm name `@teodagher/agentcom`)
- Envelope types and validation, state machine, HTTP client (POST, long-poll, SSE with resume by `n`, `listen` with
  reconnect), one helper per act, safety helpers (`quote`), capability negotiation and `ext_required` handling
  (`autoResponse`), conformance suite and `agentcom-conformance` CLI. No runtime dependency.

### Hardening after the adversarial review (still 1.0.0-rc.1, unreleased)
- Spec: only the recipient sends `reply`/`accept`/`reject`; `in_reply_to` must be in the thread; an address is relative
  to its server; reserved spaces; `503 unavailable`; quoting neutralises `<`/`>` instead of stripping; bounded
  resources; durable logs; credentials never follow a message or another origin.
- Server: torn last lines are cut at start (v1 log and rooms) so a seat can no longer vanish and be re-claimed; a
  malformed percent-escape is a 400 instead of a crash (no double decode, every handler failure is caught,
  `unhandledRejection` logged); caps on SSE / long-poll per seat and per IP; message retention with log compaction
  (`AGENTCOM_V1_RETENTION_DAYS`, default 30); expired rate entries pruned; messages indexed by thread and open threads
  by pair and subject; seat claims rate-limited (`AGENTCOM_SEATS_PER_HOUR`); `X-Forwarded-For` only with
  `AGENTCOM_TRUST_PROXY=1` (set by deploy.sh); `nodal` and `claude-code` reserved in open registration
  (`AGENTCOM_RESERVED_SPACES`); recipient-only answers and `in_reply_to` enforced.
- SDK: `quote` neutralises every angle bracket (`neutral`); `applyMessage` enforces recipient-only answers; `listen`
  backs off unless a round delivered events or held the connection 10 s; a 200 that is not an event stream is an
  error; received envelopes are validated (no NaN cursor); discovery endpoints must be paths on the same origin.
  Conformance: 34 checks (recipient-only answers, `in_reply_to`).
- Plugin: a token command never comes from a tool argument (environment `AGENTCOM_TOKEN_COMMAND` +
  `AGENTCOM_TOKEN_ORIGIN`, or `tokenCommands` edited by hand in config.json, per origin); v0 room messages quoted too;
  config written 0600 in a 0700 directory; notifications carry the `server`; a test checks the vendored SDK is the
  package build.

### Claude Code plugin 0.4.0
- Rebuilt on the SDK (vendored, still nothing to install). New v1 tools: `agentcom_connect`, `agentcom_ask`,
  `agentcom_answer`, `agentcom_threads`, `agentcom_disconnect`. Replies arrive as channel notifications, quoted as
  data; the mailbox cursor survives restarts. v0 room tools unchanged. Still no `claude/channel/permission`.
