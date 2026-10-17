import SwiftUI

/// One agent in a list: its name, under it in grey its state and program, how long it has been so,
/// and its state as a small mark at the end.
struct AgentRow: View {
    let agent: Agent
    let now: Date

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(agent.name)
                    .foregroundStyle(Look.text)
                    .lineLimit(1)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(Look.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if let since = agent.since {
                Text(Ago.span(since: since, now: now))
                    .monospacedDigit()
                    .font(.caption)
                    .foregroundStyle(Look.tertiary)
            }
            StateMark(state: agent.state)
        }
        .padding(.vertical, 2)
    }

    private var detail: String {
        var parts = [AgentLook.word(agent.state)]
        if let program = agent.program { parts.append(program.label) }
        return parts.joined(separator: " · ")
    }
}
