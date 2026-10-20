# Needs you (0.11)

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
  "decide": true, "tool": { "name": "Bash", "about": "<the command, whole>" },
  "asks": [{ "question": "Which color?", "options": ["Red", "Blue"], "descriptions": ["Warm", "Cool"], "many": true }],
  "choose": true }
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
- `tool` (0.7) is there on a `permission` whose agent's session file (`agents.md`, "Conversation")
  says which tool it waits to use: the first tool use since it last said anything that nothing was
  given back for. It names the tool (`name`) and says what it is about, whole (`about`: the exact
  command, file or address, at most 4000 characters). For a wait the agent's own hook holds
  ("Answering", 0.9) the hook names the tool and gives its input, read for `about` as the session
  file reads a tool use's: an agent may record a tool use only once it has run, so its file does
  not have the one it waits on. It is left out for a wait whose screen `says` it is something
  else, and when the agent keeps no session file or waits on no tool there.
- `asks` (0.7) is there when that tool asks the person questions (Claude Code's AskUserQuestion):
  the wait is then a `question`, whatever kind its status says, with each question and the options
  to choose from (`many`: several may be chosen); at most 4 questions of 9 options, each at most
  300 characters. `descriptions` (0.10) says what each option means, one for each option in its
  order (`""` for one that says nothing), when the tool says it of any; descriptions of another
  count, or not all text, are left out of the question, not the question from the item.
- `choose` (0.7) is `true` on a `question` its answers may be chosen for ("Answering"): any, when
  the agent's own hook holds it for the answer (0.11); else one question, with options, of which
  one is chosen, when the agent's manifest says the keys that choose an option (`choose`).

A session is named `hm:<tile>` or by its tile; both are the tile. An agent in no workspace the
device holds is not listed, nor is one doing anything else (working, done, failed, …).

Items are in order of how long they have waited, the longest first; of two waiting since the same
moment, the one whose tile comes first (by its characters' codes). A phone that has the lists of
several devices shows them as one, in the same order. An item is left out when it lacks a field
above (`says`, `plan`, `machine`, `decide`, `tool`, `asks` and `choose` may be missing), has one that
is not text (`since`: not a number), or has a `kind` not listed here. A `tool` or `asks` not shaped as
above is left out of the item, not the item from the list. An item with no `machine` (from a device of 0.2) runs on
the device that answered, and the phone shows it with that device's name. A `decide` that is not
`true`, or is on anything but a `permission`, is taken as not there, as is a `choose` that is not
`true` or is on anything but a `question`: the item is shown as it would be without it.

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
- for a `question` the list says can be chosen from (`choose`), also `{ "answers": [...] }` (0.11):
  one answer to each of its questions, in their order, each `{ "chosen": [<n>, ...] }`, the options
  chosen counting from 0, one unless the question says several may be (`many`), none twice, or
  `{ "text": "<one line>" }`, the person's own answer. Where its manifest's `choose` keys answer it
  on its screen, it is one question, one option chosen, `{n}` in the keys typed as the option's
  number counting from 1 (Claude Code's: the digit); a line there is `{ "text" }` alone;
- for anything else, `{ "text": "<one line>" }`: typed into the agent's terminal, Enter after it.
  It is one line of at most 1000 characters, with no control characters.

- for an `approval` (0.6), `{ "decision": "allow" | "deny" }`: the supervised agent's own hook
  gets it, and the tool runs or is refused. It may be answered by the person, their own devices, and
  the program on the drive socket that started the agent; anyone else is `FORBIDDEN`.

Anything else is `BAD_REQUEST`: a decision for an agent that says no keys, or for a wait that is
neither a plan, a permission nor an approval (a `question` among them), and answers for a wait not
chosen from, or that leave out a question, add one, name an option it does not list, or several of
a question that takes one, among it. One may answer who may drive the workspace's agents, and the
person's own devices, a phone among them.

What is typed is typed as the person types it at the agent's tile (0.7), so the agent's status
hears it: a key that answers its permission sets it working, and Esc or Ctrl+C on its own ends
its turn, at once, not when the agent next reports. An answer that lands is recorded with what was
decided (`allow`, `deny`, `choice ` and each question's options chosen counting from 1, joined
with `+`, or `reply` for its line, the questions apart by `, `, as `choice 3, 1+3`, or `reply` for a
line, never its words), one that does not as
`<decision>, not answered`. Nothing is typed, and it answers `{ "answered": false }`, while

- the agent's screen, read since the wait began, shows its prompt, or a wait its manifest's rules
  say is another screen (a different `says`): typed there, the keys would answer that. A screen
  the rules cannot place, or read as another kind of chooser, does not stop it;
- the keys of another answer are still going into that terminal. A program's message waits until
  they are in.

An agent may say it waits before its chooser takes keys (Claude Code's `PermissionRequest` hook
runs before its chooser is drawn), and keys typed sooner never reach the chooser. So for an agent
whose screen rules read what it waits on (its manifest's `caps.blockedDetection`, 0.8), the keys go
in only once its screen shows the wait, and the answer is confirmed only once its screen moves on
from it, or the agent waits anew. When its screen has not shown the wait within 4 s, nothing is
typed, the call fails `TIMEOUT` and the wait is not recorded as answered. When the keys are in and
its screen has not moved on 3 s later, the call fails `TIMEOUT` too, but the wait is recorded as
answered: a screen is read on a change only and may report seconds late, so the answer is not
confirmed, never failed, and answering that wait again types nothing.

An agent whose manifest says its hook can carry the answer (an `emit: input.requested` entry with
`answer:`, 0.9; Claude Code's `PermissionRequest`) is answered there instead, and nothing is typed:
its hook holds until the answer, which it prints, filled from the entry. `{ "decision" }` on a
permission prints its `allow` or `deny`, and `{ "text" }` on a permission denies it with the line as
the reason (`{message}`). On a question `{ "answers" }` prints its `choose` with each question's
answer set in the tool's input (`{input}`) at `chosen`, keyed by the question's text: the labels of
the options chosen, several joined by `, ` as Claude Code joins them, or the line typed; `{ "text" }`
prints the line as the answer to each. Several questions, and several answers, are chosen from here
too.
It answers `{ "answered": true }` once the hook has the answer. The hook holds while the agent's
status waits with that `since`: answered at the agent's own prompt (a key there, Esc, its tool run
or refused), or its turn ended, it prints nothing and the answer after is `{ "answered": false }`.
A subagent's request, a tool the entry `leave`s to the agent's own prompt, and a machine where no
desktop answers are not held: the agent's own prompt decides, and answers are typed as above.

The device that runs the agent is the one asked, and a phone sends an answer once, never again
after a reconnect. When the device does not say within 10 s whether it landed (it may have), the
phone says "Not confirmed: check the chat." and does not offer to answer that wait again.

## Sending

`agent.send(tile, text)` (0.4), a method of the workspace API, sends the agent of `tile` a
message, whatever it is doing: `text` is a prompt, at most 32768 characters, its lines broken by
newlines, with no other control characters and no bidirectional or zero-width marks (else
`BAD_REQUEST`; 0.23, before it one line of 1000), typed into its terminal as its next prompt once
it is at its prompt (held while it is in a turn), Enter after it. An agent whose manifest says it
reads a message typed while it works (`steer`) is given it at once, into the turn it is in, as the
person types one at its terminal (0.33). The `agent.read` after it waits for the turn it starts
(0.23). It answers `{ "sent": true }`, with `"held": true` while it waits for the turn to end
(0.33), or `{ "sent": false }` when no agent runs there. A device shows the message as the
person's at once, held or not, and shows it from the agent's session file once that has it; one
held offers to stop the turn (`agent.interrupt`), after which it goes. A message may carry up to 4
photos (`agent.send`'s `images`, 0.33); one held keeps them. One may send who may drive
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
