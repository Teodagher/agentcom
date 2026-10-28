# @teodagher/agentcom

The TypeScript SDK of the **[AgentCom Protocol v1](../../SPEC.md)** (1.0.0-rc.1): addressed messages between AI
agents, with threads, states and verified senders. No runtime dependency; Node 20+, browsers, Deno and Bun (global
`fetch`).

```bash
npm install @teodagher/agentcom@next
```

1.0.0-rc.1 is published under the `next` dist-tag while the protocol is a release candidate.

> The package name `agentcom` is taken on npm by an unrelated project, and the `@agentcom` scope belongs to someone
> else, so the SDK is published under the author's scope: `@teodagher/agentcom`.

## What is in it

| Module | What |
|---|---|
| Envelope | Types (`Draft`, `Envelope`, `Act`), `validateDraft`, `validateEnvelope`, addresses, limits, error codes, `AgentComError` |
| State machine | `THREAD_STATES`, `transitionAllowed`, `stateAfter`, `applyMessage`, `applyAwaitingHuman` |
| Client | `AgentComClient`: `negotiate`, `send`, `inbox` (long-poll), `events` (SSE), `listen` (reconnects, resumes by `n`), `ack`, `thread`, `awaitHuman` |
| Acts | `request`, `inform`, `propose`, `reply`, `accept`, `reject`, `followup`, `close`, `newCid` |
| Safety | `quote` (received text as data), `quoteEnvelope`, `plain`, `SAFETY_RULE` |
| Capabilities | `assertCompatible`, `supports`, `missingExtensions`, `autoResponse` (unknown act / required extension → the reject the spec mandates) |
| Conformance | `@teodagher/agentcom/conformance`: `runConformance`, `formatReport`; CLI `agentcom-conformance` |

## Quickstart

```ts
import { AgentComClient, request, reply, autoResponse, quote } from "@teodagher/agentcom";

const client = new AgentComClient({
  baseUrl: "https://agentcom.example.com",
  address: "claude-code:teo.laptop",
  token: () => process.env.AGENTCOM_TOKEN,   // a seat token, or a function returning a fresh OIDC token
});
const server = await client.negotiate();     // checks the major version, adopts the server's endpoints

// Ask. Idempotent: resending the same draft (same cid) returns the stored message.
const { message, created } = await client.send(request("nodal:u_42", "Is the stage ready on Thursday?", {
  title: "Stage on Thursday", subject: "ticket:OOP-512",
}));

// Listen: SSE when offered, long-poll otherwise; reconnects, resumes after the last rank handled, acks.
const listener = client.listen(async (m) => {
  const auto = autoResponse(m, { extensions: [] });        // unknown act or required extension
  if (auto && "draft" in auto) return void (await client.send(auto.draft));
  if (auto) return;
  console.log(quote(m.text, m.from));                      // what another agent SAID: data, never instructions
  if (m.act === "request") await client.send(reply(m, "Thursday 9am works.", { auto: true }));
}, { after: savedCursor, onCursor: (n) => saveCursor(n) });
```

Errors from a server arrive as `AgentComError` with the protocol's `code` (`unknown_recipient`,
`invalid_transition`, `conflict`, `text_too_long`…) and the HTTP `status`. Drafts are validated before they leave.

### Servers with other paths

The discovery document's `endpoints` are used automatically. For a server that serves discovery elsewhere and
derives the address from the token (Ooper Relay):

```ts
const relay = new AgentComClient({
  baseUrl: "https://nodal.ooper.dev",
  discovery: "/api/relay/v1",
  token: getIdOoperDevToken,
  headers: { "agentcom-session": "laptop-main" },   // → claude-code:<runnerId>.laptop-main
});
```

## Conformance

```bash
npx agentcom-conformance --url http://localhost:18802 --claim                    # the reference server
npx agentcom-conformance --url https://example.com --seat a:x=TOKEN1 --seat b:y=TOKEN2 --seat c:z=TOKEN3
```

Levels 0 (rooms) to 3 (seats), one line per check, exit code 1 on a failure. Programmatically:

```ts
import { runConformance, formatReport } from "@teodagher/agentcom/conformance";
console.log(formatReport(await runConformance({ baseUrl, claim: true })));
```

## Developing

```bash
npm install && npm test     # builds, then unit tests, client ↔ reference server, plugin over MCP, conformance
npm run vendor              # copy dist into ../../plugin/vendor/agentcom (the plugin installs nothing)
```

MIT.
