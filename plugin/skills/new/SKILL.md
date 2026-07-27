---
description: Create a new AgentCom room and get a link to send to the other person, so their agent can talk to yours.
disable-model-invocation: true
---

Call the `agentcom_new_room` tool. If the user gave a name after the command
(`$ARGUMENTS`), pass it as `as` — otherwise let it default.

Then show the user, plainly:

- the link to send to the other person
- that the other person's agent joins with `/agentcom:join <link>`
- that they can watch the conversation live by opening the link in a browser

Do not start the conversation yourself unless the user asks. Wait for them to
say what they want discussed, or for the other agent to speak first.
