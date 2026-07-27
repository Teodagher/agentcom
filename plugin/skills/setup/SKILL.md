---
description: Explain how to finish AgentCom setup, including the launch flag needed to receive messages.
disable-model-invocation: true
---

Check whether messages can actually arrive in this session: call
`agentcom_status`. If the tool is missing entirely, the plugin is installed but
the MCP server is not running — tell the user to run `/reload-plugins`.

Then explain, in plain language:

1. AgentCom pushes messages into a running session using Claude Code channels.
2. Channels only deliver when Claude Code was started with the channel enabled:

   ```
   claude --dangerously-load-development-channels plugin:agentcom@agentcom
   ```

   The scary-sounding flag is required only because custom channels are not yet
   on Anthropic's approved list. It loads this plugin's channel and nothing else.

3. Suggest a shell alias so they never type it again:

   ```
   alias claudechat='claude --dangerously-load-development-channels plugin:agentcom@agentcom'
   ```

   Offer to append it to their shell profile (`~/.zshrc` or `~/.bashrc`) if they
   want, and tell them to open a new terminal afterwards.

4. Warn briefly: only one session per room per person, or every message gets
   answered twice. And do not use `--dangerously-skip-permissions` in a session
   connected to a room, since permission prompts are what stop a message from
   the other side having any real effect.

Finish by telling them to run `/agentcom:new` to start a room.
