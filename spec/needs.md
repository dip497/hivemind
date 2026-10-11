# Needs you (0.7)

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
  "agent": "<what the agent is called>", "kind": "permission", "says": "trust", "since": 1790000000000,
  "plan": "<the plan, in markdown>", "machine": "<what the machine it runs on is called>",
  "decide": true }
```

- `says` (0.6) is what screen it waits on, when the agent's manifest names it: a detect rule that
  reads the agent's screen as waiting may say what that screen is (`says: trust`, its trust
  prompt). It is left out when no rule names it. A different screen is a different wait.
- `since` is when it began waiting (ms since the epoch): with `tile`, it says which wait this is,
  so an answer to an earlier one is told apart (step 4). Each wait's is later than the one
  before's, even when the next begins within the same millisecond (0.7).
- `agent` is what the person named its tile; else what the agent says it is doing (its title);
  else what it was started to do (its task); else its tile's label.
- `plan` is there for a `plan`, when the agent handed one off for review: its text.
- `machine` (0.3) is the machine the agent runs on: the one its frame's folder is on (its
  worktree's, when it has one), else its workspace's folder's when the frame names none or the
  agent is in no frame. It is called as the device knows it: the device's own name for itself; one
  of the person's other devices by its name; a participant's computer as `<their name>'s computer`
  (`someone's computer` when their name is not known); a saved machine by its name; the host of an
  `ssh://` folder; and one the device no longer knows as `a device not paired here` or `a machine
  no longer saved`.
- `decide` (0.5) is `true` on a `permission` the device can allow or deny ("Answering"): the
  agent's manifest says which of its keys allow what it asks on its screen and which deny it, for
  the screen it `says` it is (`answer.trust`), else for a permission (`answer.permission`). It is
  left out otherwise: for any other kind, and for an agent that says no keys for it, whose
  permission is answered with a line, as the person would answer it on its screen.

A session is named `hm:<tile>` or by its tile; both are the tile. An agent in no workspace the
device holds is not listed, nor is one doing anything else (working, done, failed, …).

Items are in order of how long they have waited, the longest first; of two waiting since the same
moment, the one whose tile comes first (by its characters' codes). A phone that has the lists of
several devices shows them as one, in the same order. An item is left out when it lacks a field
above (`says`, `plan`, `machine` and `decide` may be missing), has one that is not text (`since`: not a
number), or has a `kind` not listed here. An item with no `machine` (from a device of 0.2) runs on
the device that answered, and the phone shows it with that device's name. A `decide` that is not
`true`, or is on anything but a `permission`, is taken as not there: the item is shown as it would
be without it.

## Answering

`agent.answer(tile, since, answer)`, a method of the workspace API (`workspace-api.md`), answers
what the agent of `tile` waits on the person for, naming the wait as the list does (`since`). It
answers `{ "answered": true }` only while that agent still waits on the person with that `since`,
and once: an answer for a wait that is over, or one answered already, does nothing and answers
`{ "answered": false }`. The answer is

- for a `plan`, `{ "decision": "allow" | "deny", "feedback"?: "<what to change>" }`: the plan is
  decided: the first answer is the one the agent gets, a later one hears who gave it (`by`), and
  everyone is told who decided it (`agent.event` `answered`);
- for a `permission` the list says the device can decide (`decide`, 0.5), also
  `{ "decision": "allow" | "deny" }`: the keys the agent's manifest gives for that decision, on
  the screen it `says` it is (0.6), are
  typed into its terminal, the first at once and each next one a moment (40 ms) after the last, so
  its screen takes each one;
- for anything else, `{ "text": "<one line>" }`: typed into the agent's terminal, Enter after it.
  It is one line of at most 1000 characters, with no control characters.

- for an `approval` (0.6), `{ "decision": "allow" | "deny" }`: the supervised agent's own hook
  gets it, and the tool runs or is refused. It may be answered by the person, their own devices, and
  the program on the drive socket that started the agent; anyone else is `FORBIDDEN`.

Anything else is `BAD_REQUEST`: a decision for an agent that says no keys, or for a wait that is
neither a plan, a permission nor an approval, among it. One may answer who may drive the workspace's agents, and the
person's own devices, a phone among them.

What is typed is typed as the person types it at the agent's tile (0.7), so the agent's status
hears it: a key that answers its permission sets it working, and Esc or Ctrl+C on its own ends
its turn, at once, not when the agent next reports. An answer that lands is recorded with what was
decided (`allow`, `deny`, or `reply` for a line, never its words), one that does not as
`<decision>, not answered`. Nothing is typed, and it answers `{ "answered": false }`, while

- the agent's screen, read since the wait began, shows its prompt, or a wait its manifest's rules
  say is another screen (a different `says`): typed there, the keys would answer that. A screen
  the rules cannot place, or read as another kind of chooser, does not stop it;
- the keys of another answer are still going into that terminal. A program's message waits until
  they are in.

The device that runs the agent is the one asked, and a phone sends an answer once, never again
after a reconnect. When the device does not say within 10 s whether it landed (it may have), the
phone says "Not confirmed: check the chat." and does not offer to answer that wait again.

## Sending

`agent.send(tile, text)` (0.4), a method of the workspace API, sends the agent of `tile` a
message, whatever it is doing: `text` is a prompt, at most 32768 characters, its lines broken by
newlines, with no other control characters and no bidirectional or zero-width marks (else
`BAD_REQUEST`; 0.23, before it one line of 1000), typed into its terminal as its next prompt once
it is at its prompt (held while it is in a turn), Enter after it. The `agent.read` after it waits
for the turn it starts (0.23). It answers `{ "sent": true }`, or `{ "sent": false }` when no agent
runs there. One may send who may drive
the workspace's agents, and the person's own devices, a phone among them. A phone may also type
into a terminal it watches, as the person, asking for its keyboard while someone else holds it
(`workspace-api.md`, "Peers").

## Asking

One of the person's devices asks another on the `device` stream of a connection on `hive/ws/1`
(the stream it asks which workspaces are there on): `{ "t": "needs" }`, and is answered
`{ "t": "needs", "needs": [ … ], "working": 3 }`: the list above, and how many agents in the
workspaces the device holds are at work now (their status `working`, 0.2). A phone may ask this
and which workspaces there are, give where it is told what happens there (`push.md`) and unpair
itself (`pairing.md`), and nothing else there.

A phone shows the lists of the devices that answered as one, and how many agents are at work on
them together; an answer that does not say how many, or says it as anything but a whole number of
none or more, counts none. A device that does not answer within a few seconds, or cannot be
reached, is said to be away, with what it last answered the phone and when, if it ever did (0.2).
The phone keeps which devices it found away, and when it last did, until each answers again or
says it is back (`push.md` 0.2).
