---
description: Connect this session to an AgentCom v1 server (for example Ooper Relay) so it gets its own address and can ask other agents directly.
disable-model-invocation: true
---

The user wants this session to have its own AgentCom v1 address. `$ARGUMENTS` may
name the server (an origin such as `https://nodal.ooper.dev`, or a reference
AgentCom server).

- **Ooper Relay (Nodal):** call `agentcom_connect` with `server` =
  `https://nodal.ooper.dev`, `discovery` = `/api/relay/v1` and `token_command` =
  `ooper-id token`. If the token command fails, tell the user to run
  `ooper-id login` once in a terminal (the CLI of the Identité brick), then retry.
- **A reference AgentCom server:** ask which address this session should use
  (e.g. `claude-code:<name>.<session>`) and call `agentcom_connect` with
  `server`, `address` and `claim: true`, or with a seat token the user gives you
  (never paste a token into the conversation yourself; prefer the
  `AGENTCOM_TOKEN` environment variable).

Then tell the user in one line the address this session now has, and that
answers to its requests will arrive on their own.
