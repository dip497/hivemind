# View protocol 1.4 — agents: status, catalog, sessions, prompts

Builds on 1.3 (`view-protocol-1.3-2026-09-23.md`) and the agent host
(`agent-host-oss-2026-09-25.md`). `PROTOCOL_VERSION` stays 1; a host lists what it wired in
`hello.features`, as in 1.3 §4.0.

## 1. Why

A view sees a tile's status as five buckets and can start an agent. Everything else the host now
knows about agents — why one is waiting, how its last turn ended, its subagents, which agents are
installed and what they support, the past sessions it can continue — a view cannot see, and it
cannot hand an agent its next instruction. A board, a queue or a standup view needs all of it.

## 2. The additions

| Feature | Wire | Permission |
|---|---|---|
| `agentStatus` | `status.agent`: state, what it waits for, subagents, background shells, compacting, source; `turn` events carry `outcome` | none |
| `agents` | `request "agents"` → the spawnable agents and what each supports | none |
| `sessions` | `request "sessions" {agent, frameId}` → that folder's past sessions; `spawnAgent(…, {resume})` continues one | `workspace:sessions` |
| `prompt` | `request "prompt" {tileId, text}` → `sent` / `cancelled`; `spawnAgent(…, {prompt})` now needs it too | `workspace:prompt`, and the user confirms every prompt |

### 2.1 `agentStatus`

```ts
type ViewAgentState = "idle" | "working" | "waiting" | "done" | "failed" | "interrupted" | "limited" | "exited";
interface ViewAgentStatus {
  state: ViewAgentState;
  waitingFor?: "permission" | "question" | "plan" | "approval" | "other";
  subagents: number; background: number; compacting: boolean;
  /** "hooks": the agent reports it; "screen": read from its screen (coarser). */
  source?: "hooks" | "screen";
}
| { type: "status"; tileId; status; since?; exact?; /** 1.4 */ agent?: ViewAgentStatus }
| { kind: "turn"; …; /** 1.4 */ outcome?: "done" | "failed" | "interrupted" | "limited" }
```

The host's status store (`spec/status.md`) is the source; the bucket is unchanged, so a 1.3 view
reads the same `status`. Fixed words and counts only: no subagent names, no titles. No permission,
for 1.3 §4.7's reason — a category of a state the view already sees.

### 2.2 `agents`

`request "agents"` → `{ agents: [{ id, label, default, turns, resumes, sessions }] }`: the agents
this machine can start, whether each reports its turns, can resume a session, and can list them.
What the Settings page shows; no permission.

### 2.3 `sessions` (permission `workspace:sessions`)

`request "sessions" { agent, frameId }` → `{ sessions: [{ id, updated?, prompt? }] }`, newest
first, for the folder that frame is bound to. `spawnAgent(agent, frameId, { resume: id })` starts
the agent on one of them in that frame.

- **Scope:** a frame, never a path. The host maps the frame to its folder; a view never names or
  learns a path. A frame with no folder, or on another machine, answers `UNSUPPORTED`.
- **`prompt`** is the first line of the session's first prompt, the user's own words, ≤ 200
  characters, when the agent's plugin says where it is (`session.list.promptPath`). A title the
  agent wrote is never sent (the host's rule: no agent-written text to views).
- **Why a permission:** unlike 1.3's history, this reaches back before the view was installed and
  carries the user's words. The install review says "see your past agent sessions in its folders
  and continue them".
- **Resume** needs `workspace:spawn` and `workspace:sessions`; the id must be one the listing
  could return (the host checks its shape; the agent is started with its own resume flag).

### 2.4 `prompt` (permission `workspace:prompt`) — 1.3 §2.3, now done

`request "prompt" { tileId, text }` types an instruction into an agent tile and submits it (held
while the agent is mid-turn, like `hive ctl send`). `spawnAgent(…, { prompt })` needs the
permission too — **Breaking** for 1.2 views that prompt with `workspace:spawn` alone.

Every prompt opens a host confirm, never inside the view: the view's name, the agent and where it
runs, the full text, **Send** / **Cancel** with focus on Cancel. One pending per view; after three
cancels the host answers `DECLINED` until the view is remounted; nothing opens while the view is
hidden. The text is refused if it carries C0/C1 controls other than `\n` and `\t`, or bidi and
zero-width characters, in the SDK and the host alike.

## 3. Deliberately not in 1.4

- **Replies** (`hive ctl read`): what an agent wrote. The host's rule keeps agent-written text out
  of views.
- **Approvals** (`hive ctl approve`): deciding what an agent may run is the user's, or a
  supervising agent's, never a view's.
- **Agent-written session titles** — see 2.3.
