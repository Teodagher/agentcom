---
description: Connect this session to an AgentCom v1 server (for example Ooper Relay) so it gets its own address and can ask other agents directly.
disable-model-invocation: true
---

The user wants this session to have its own AgentCom v1 address. `$ARGUMENTS` may
name the server (an origin such as `https://nodal.ooper.dev`, or a reference
AgentCom server).

- **Ooper Relay (Nodal):** call `agentcom_connect` with `server` =
  `https://nodal.ooper.dev` and `discovery` = `/api/relay/v1`. The token comes
  from a command the **user** configures for that exact origin — never from
  you: either `AGENTCOM_TOKEN_COMMAND="ooper-id token"` with
  `AGENTCOM_TOKEN_ORIGIN=https://nodal.ooper.dev` in their environment, or
  `"tokenCommands": {"https://nodal.ooper.dev": "ooper-id token"}` added by hand
  to `~/.claude/agentcom/config.json`. If it is missing or fails, tell the user
  how to set it up (and to run `ooper-id login` once); do not edit that file.
- **A reference AgentCom server:** ask which address this session should use
  (e.g. `agent:<name>.<session>`; `nodal:` and `claude-code:` are reserved on
  open servers) and call `agentcom_connect` with
  `server`, `address` and `claim: true`, or with a seat token the user gives you
  (never paste a token into the conversation yourself; prefer the
  `AGENTCOM_TOKEN` environment variable).

Then tell the user in one line the address this session now has, and that
answers to its requests will arrive on their own.
