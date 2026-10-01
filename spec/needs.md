# Needs you (0.1)

What waits on the person (M5, design §9.2 "Home: Needs you"): each agent waiting on them, in the
workspaces one of their devices holds, as their phone lists it. The device that runs the agents
works it out and answers; the phone asks each of the person's devices it knows and shows the
lists as one. The cases in `../conformance/needs.json` decide whether an implementation follows
this.

## What waits on the person

An agent waits on the person while its status (`status.md`) is `waiting`, with a `kind`:
`permission`, `question`, `plan` or `other`. (One waiting for an `approval` waits on the agent that
supervises it, which answers it, not on the person.) Each such agent in a workspace the device
holds is one item:

```json
{ "workspace": "<the workspace's id>", "name": "<the workspace's name>", "tile": "<the agent's tile>",
  "agent": "<what the agent is called>", "kind": "permission", "since": 1790000000000,
  "plan": "<the plan, in markdown>" }
```

- `since` is when it began waiting (ms since the epoch): with `tile`, it says which wait this is,
  so an answer to an earlier one is told apart (step 4).
- `agent` is what the person named its tile; else what the agent says it is doing (its title);
  else what it was started to do (its task); else its tile's label.
- `plan` is there for a `plan`, when the agent handed one off for review: its text.

A session is named `hm:<tile>` or by its tile; both are the tile. An agent in no workspace the
device holds is not listed, nor is one doing anything else (working, done, failed, …).

Items are in order of how long they have waited, the longest first; of two waiting since the same
moment, the one whose tile comes first (by its characters' codes). A phone that has the lists of
several devices shows them as one, in the same order. An item is left out when it lacks a field
above (`plan` may be missing), has one that is not text (`since`: not a number), or has a `kind`
not listed here.

## Answering

`agent.answer(tile, since, answer)`, a method of the workspace API (`workspace-api.md`), answers
what the agent of `tile` waits on the person for, naming the wait as the list does (`since`). It
answers `{ "answered": true }` only while that agent still waits on the person with that `since`,
and once: an answer for a wait that is over, or one answered already, does nothing and answers
`{ "answered": false }`. The answer is

- for a `plan`, `{ "decision": "allow" | "deny", "feedback"?: "<what to change>" }`: the plan is
  decided as at the desktop (`plan.decide`), and everyone is told who decided it;
- for anything else, `{ "text": "<one line>" }`: typed into the agent's terminal, Enter after it.
  It is one line of at most 1000 characters, with no control characters.

Anything else is `BAD_REQUEST`. One may answer who may drive the workspace's agents, and the
person's own devices, a phone among them.

## Asking

One of the person's devices asks another on the `device` stream of a connection on `hive/ws/1`
(the stream it asks which workspaces are there on): `{ "t": "needs" }`, and is answered
`{ "t": "needs", "needs": [ … ] }`. A phone may ask this and which workspaces there are, and give
where it is told what happens there (`push.md`), and nothing else there (`pairing.md`). A device that does not answer within a few seconds, or cannot
be reached, is said to be away; what it last said is not kept.
