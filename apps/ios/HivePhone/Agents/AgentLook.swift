import SwiftUI

/// The Agents tab's sections (design §6.3): the core's order (by device, then workspace, then name)
/// cut wherever the device or the workspace changes.
struct AgentSection: Identifiable {
    let id: String
    let title: String
    var agents: [Agent]

    static func of(_ agents: [Agent]) -> [AgentSection] {
        var sections: [AgentSection] = []
        for agent in agents {
            let id = agent.at.device + "\n" + agent.at.workspace
            if sections.last?.id == id {
                sections[sections.count - 1].agents.append(agent)
            } else {
                sections.append(AgentSection(
                    id: id, title: "\(agent.deviceName) · \(agent.workspaceName)", agents: [agent]))
            }
        }
        return sections
    }
}

/// How an agent's state reads and shows, and what it may be asked.
enum AgentLook {
    static func word(_ state: AgentState) -> String {
        switch state {
        case .idle: return "idle"
        case .working: return "working"
        case .waiting: return "waiting on you"
        case .done: return "done"
        case .failed: return "failed"
        case .interrupted: return "stopped"
        case .limited: return "at its limit"
        case .exited: return "exited"
        }
    }

    static func color(_ state: AgentState) -> Color {
        switch state {
        case .working: return .green
        case .waiting: return .orange
        case .failed: return .red
        case .limited: return .yellow
        case .done: return .blue
        case .idle, .interrupted, .exited: return .gray
        }
    }

    /// Stop is offered while it works and its manifest says how to interrupt it (design §6.3). Not
    /// while it waits: its interrupt keys (Claude Code's: Esc) would answer the prompt with "no".
    static func offersStop(_ agent: Agent) -> Bool {
        if case .working = agent.state { return agent.canInterrupt }
        return false
    }
}
