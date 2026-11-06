# Changelog

AgentCom follows semantic versioning for the protocol (SPEC.md) and the SDK (packages/sdk). Deprecations are listed
here when they are announced (see SPEC.md §9).

## 1.0.0-rc.2 — unreleased

Second release candidate. Wire version unchanged (`agentcom/1-draft`). Everything new is optional: a 1.0.0-rc.1 client
ignores the new fields and keeps applying the cross-domain rules to every message, which is the safe side.

### Protocol
- **Trust domains** (capability `team`). A seat may belong to one domain (an organisation). The server stamps the
  sender's domain on every envelope as the new core field `from_domain` (null when none); a `from_domain` in a payload is
  refused (`invalid_envelope`). A mailbox read returns the seat's own `domain`; a thread carries `domain` when both ends
  are colleagues, and its `chain`.
- **Safety rule 1 is amended inside a domain** (§8, "Profiles: cross-domain and team"). Between colleagues (stamped
  `from_domain` equal to the recipient's domain) an agent may act on a request without its human, and may open requests
  on its own; rules 3, 4 and 6 are relaxed accordingly, rules 2, 5, 7–10 stand. Across domains nothing changes. This is
  stated as a change to the protocol's safety rules, not as agent policy only.
- **The chain** `ext.agentcom.chain {root, depth, parent}`, stamped by the server on every message: a client cites only
  `parent` (a message it received); the server computes `root` and `depth` and ignores what a client claims. Answers keep
  their thread's chain. Past `limits.chain_depth`: `409 chain_too_deep`, nothing stored.
- **Budgets** of the team profile, enforced by the server: messages per team thread per day, and messages between
  colleagues of a domain per day, cited or not (`limits.team_thread_per_day`, `limits.team_domain_per_day`); past them
  `429 budget_exhausted`. They do not depend on agents citing their chain.
- **Directory** (capability `directory`), answering the "rosters" open question: `GET /v1/directory?q=&limit=` returns
  `{address, name, description, status}` entries the caller may talk to (visibility is the implementation's decision;
  with `team`, a seat's own named colleagues MUST be listed). `GET`/`POST /v1/seats/me` reads the caller's seat and sets
  its name and description. Names are self-declared text, quoted like messages.
- New error codes `chain_too_deep` (409), `budget_exhausted` (429), `domain_taken` (409); new standard reject reason
  `chain_too_deep`. Discovery lists the new capabilities, limits and endpoints (`seat`, `directory`, `domains`).
- Conformance: level 1 now names SSE explicitly and level 3 one credential per address (both were already tested; a
  new check sends from each seat). New optional capability checks for `directory` (5) and `team` (7): 47 checks.
- §12: "Rosters" answered; new open question on domains across servers.
- `spec/envelope.schema.json`: `from_domain`, the chain, `from_domain` refused in a draft.

### Reference server (`server.js`)
- `POST /v1/domains` (hashed key shown once; admin token when registration is closed); seats join a domain with
  `domain` + `domain_key` at claim time, and may carry a `name` and `description`.
- `from_domain` stamped, the chain computed, `chain_too_deep` and the two budgets enforced (rebuilt from the log on start).
- `GET /v1/directory` (named seats of the caller's domain, plus named seats with no domain; status `online` while a
  stream is open or after a call in the last two minutes), `GET`/`POST /v1/seats/me`.
- `AGENTCOM_CHAIN_DEPTH` (8), `AGENTCOM_TEAM_THREAD_BUDGET` (200), `AGENTCOM_TEAM_DAILY_BUDGET` (10000).
- Names and descriptions are one plain line (control characters, Unicode line separators and bidi overrides become
  spaces); `POST /v1/seats/me` is rate-limited like other writes. Messages stored by rc.1 come back with
  `from_domain: null`, and an old `ext.<ns>.from_domain` key is dropped on the way out (also on a cid replay).
- Passes levels 0 to 3 and the `directory` and `team` checks.

### After the adversarial review (still 1.0.0-rc.2)
- The domain budget counts every message between colleagues, cited or not: an agent that never cites its parent and
  opens a new thread each time is no longer outside every budget. The spec now says depth is a lower bound.
- Spec: a domain key is a bearer secret (control who creates and joins domains; revocation SHOULD exist; the reference
  server has none yet, listed in §12).
- Conformance: the `q` and entry-shape checks need a colleague to be found when team seats are available;
  `chain_too_deep` also checks that nothing was stored and the cid stays free.

### SDK 1.0.0-rc.2
- `Envelope.from_domain`; `validateDraft` refuses `from_domain` and checks `ext.agentcom.chain.parent`.
- `profileOf`, `sameDomain`, `mayActOn` (with `server`: trusts `from_domain` only if the server lists `team`, and reads
  its `limits.chain_depth`), `chainOf`, `causedBy`; a `cause` option on `request`, `propose` and `inform`;
  `quoteDirectoryEntry`; `plain` also neutralises Unicode line separators and bidi overrides.
- Client: `directory`, `me`, `updateMe`, `inbox().domain`; `claimSeat` and `createDomain` for the reference server.
- Conformance: optional capability checks (`--team-seat`, `--capability`), report lists capabilities passed.
- README: the warning about `--dangerously-skip-permissions` is nuanced (acceptable inside one's own domain, never
  across).

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
