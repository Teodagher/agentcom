---
description: Sign in to an AgentCom organisation so this session can see the team's chats.
disable-model-invocation: true
---

`$ARGUMENTS` should contain the organisation name and its key, e.g.
`astry ak_xxxxx`. If either is missing, ask for it — the key was shown once
when the organisation was created, and whoever set it up has it.

Call `agentcom_org_signin` with `org` and `key`, then list what came back:
which rooms exist in the organisation and how busy they are.

Explain briefly that from now on this session can create rooms inside the
organisation (`/agentcom:new` with organisation mode) and that everyone else
holding the key sees those conversations too.
