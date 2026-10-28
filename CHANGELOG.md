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

### SDK (`packages/sdk`, npm name `agentcom-sdk`)
- Envelope types and validation, state machine, HTTP client (POST, long-poll, SSE with resume by `n`, `listen` with
  reconnect), one helper per act, safety helpers (`quote`), capability negotiation and `ext_required` handling
  (`autoResponse`), conformance suite and `agentcom-conformance` CLI. No runtime dependency.

### Claude Code plugin 0.4.0
- Rebuilt on the SDK (vendored, still nothing to install). New v1 tools: `agentcom_connect`, `agentcom_ask`,
  `agentcom_answer`, `agentcom_threads`, `agentcom_disconnect`. Replies arrive as channel notifications, quoted as
  data; the mailbox cursor survives restarts. v0 room tools unchanged. Still no `claude/channel/permission`.
