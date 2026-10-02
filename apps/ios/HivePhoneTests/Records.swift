import Foundation
@testable import HivePhone

// The core's records (design §5.2, §5.3), built as a test needs them: no core runs in these tests.

func anAgent(
    device: String = "d1",
    workspace: String = "w1",
    tile: String = "t1",
    name: String = "fix the login",
    deviceName: String = "desk",
    workspaceName: String = "hivemind",
    state: AgentState = .working,
    waiting: Waiting? = nil,
    canInterrupt: Bool = true,
    hasConversation: Bool = false
) -> Agent {
    Agent(
        at: AgentRef(device: device, workspace: workspace, tile: tile),
        name: name,
        workspaceName: workspaceName,
        deviceName: deviceName,
        machine: deviceName,
        program: Program(id: "claude", label: "Claude Code"),
        state: state,
        since: nil,
        waiting: waiting,
        canInterrupt: canInterrupt,
        hasConversation: hasConversation)
}

func aWait(_ kind: WaitKind, decide: Bool = false) -> Waiting {
    Waiting(kind: kind, since: 1_700_000_000_000, plan: kind == .plan ? "1. Read the tests" : nil, decide: decide)
}

func aLine(_ index: UInt64, _ text: String) -> ScreenLine {
    ScreenLine(index: index, text: text, runs: Data())
}

/// A screen update; the cursor on the newest line, shown, unless told where and whether.
func anUpdate(
    revision: UInt64, cols: UInt16 = 80, rows: UInt16 = 24, first: UInt64, count: UInt64,
    cursor: UInt64? = nil, cursorShown: Bool = true, _ lines: [ScreenLine]
) -> ScreenUpdate {
    ScreenUpdate(
        revision: revision,
        cols: cols,
        rows: rows,
        firstLine: first,
        lineCount: count,
        cursorLine: cursor ?? (count == 0 ? 0 : count - 1),
        cursorCol: 0,
        cursorVisible: cursorShown,
        lines: lines)
}

// A conversation's entries (design §5.4), each whole as the core hands it on: the person's text,
// the agent's text or a tool it used, a tool's result.

func personSays(_ id: String, _ text: String = "fix the nav") -> Entry {
    Entry(id: id, at: 1_790_000_000_000, said: .person(text: text))
}

func agentSays(_ id: String, _ text: String = "On it.") -> Entry {
    Entry(id: id, at: 1_790_000_000_000, said: .agent(text: text))
}

func agentUses(_ id: String, tool: String, about: String? = "src/nav.ts") -> Entry {
    Entry(id: id, at: 1_790_000_000_000, said: .toolUse(tool: Tool(id: tool, name: "Edit", about: about)))
}

func toolGives(_ id: String, of tool: String, _ text: String = "done", error: Bool = false) -> Entry {
    Entry(id: id, at: 1_790_000_000_000, said: .toolOutput(result: ToolResult(of: tool, text: text, error: error)))
}
