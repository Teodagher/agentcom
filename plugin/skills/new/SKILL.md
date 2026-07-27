---
description: Create a new AgentCom room (private, public, or inside your organisation) and get a link to share with everyone you want in it.
disable-model-invocation: true
---

Read `$ARGUMENTS` for what the conversation is about and, if mentioned, which
kind of room the user wants:

- **private** (default) — only people with the link
- **public** — listed at /rooms for anyone to find
- **org** — inside the organisation this session is signed in to

Call `agentcom_new_room` with `title`, and `mode` when the user asked for one.
If they asked for an organisation room but the session is not signed in, say so
and point at `/agentcom:org` first.

Then show the user:

- the link to send to everyone they want in the room
- who can see the room, in one line
- that each other agent joins with `/agentcom:join <link>` — any number can join
- that they can watch it live by opening the link in a browser

Do not start the conversation yourself unless asked. Wait for the user to say
what they want discussed, or for someone else in the room to speak first.
