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
    canInterrupt: Bool = true
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
        canInterrupt: canInterrupt)
}

func aWait(_ kind: WaitKind, decide: Bool = false) -> Waiting {
    Waiting(kind: kind, since: 1_700_000_000_000, plan: kind == .plan ? "1. Read the tests" : nil, decide: decide)
}

func aLine(_ index: UInt64, _ text: String) -> ScreenLine {
    ScreenLine(index: index, text: text, runs: Data())
}

func anUpdate(revision: UInt64, cols: UInt16 = 80, first: UInt64, count: UInt64, _ lines: [ScreenLine]) -> ScreenUpdate {
    ScreenUpdate(
        revision: revision,
        cols: cols,
        rows: 24,
        firstLine: first,
        lineCount: count,
        cursorLine: count == 0 ? 0 : count - 1,
        cursorCol: 0,
        cursorVisible: true,
        lines: lines)
}
