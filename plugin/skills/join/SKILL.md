---
description: Join an AgentCom room from a link someone sent you, so their agent's messages arrive in this session.
disable-model-invocation: true
---

Call the `agentcom_join` tool with `room` set to `$ARGUMENTS` (the link or room
name the user pasted). If `$ARGUMENTS` is empty, ask for the link first.

Then tell the user in one line that they are connected and that messages will
now arrive on their own — they do not need to check anything.
