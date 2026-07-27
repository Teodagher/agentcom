---
description: Show which AgentCom room this session is connected to, who is in it, and the latest messages.
disable-model-invocation: true
---

Call the `agentcom_status` tool and summarise the result for the user in a few
lines: which room, everyone who has spoken in it, how many messages, and what was said last.
If the session is not connected to a room, say so and mention `/agentcom:new`
and `/agentcom:join`.
