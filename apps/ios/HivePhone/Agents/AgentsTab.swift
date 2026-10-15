import SwiftUI

/// Every agent, live, by device and workspace (design §6.3): its state, its name, for how long.
/// Swipe to stop it or close it; + starts one.
@MainActor
struct AgentsTab: View {
    let model: PhoneModel
    @State private var path: [AgentRef] = []
    @State private var starting = false

    var body: some View {
        NavigationStack(path: $path) {
            TimelineView(.everyMinute) { context in
                List {
                    ForEach(AgentSection.of(model.overview.agents)) { section in
                        Section {
                            ForEach(section.agents, id: \.at) { agent in
                                NavigationLink(value: agent.at) {
                                    AgentRow(agent: agent, now: context.date)
                                }
                                .pageRow()
                                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                    Button(role: .destructive) {
                                        Task { _ = await model.close(agent.at, named: agent.name) }
                                    } label: {
                                        Label("Close", systemImage: "xmark")
                                    }
                                    if AgentLook.offersStop(agent) {
                                        Button {
                                            model.act { _ = try await model.phone.interrupt(agent: agent.at) }
                                        } label: {
                                            Label("Stop", systemImage: "stop.fill")
                                        }
                                        .tint(.gray)
                                    }
                                }
                            }
                        } header: {
                            GroupLabel(section.title)
                                .textCase(nil)
                        }
                    }
                }
                .listStyle(.plain)
                .pageGround()
                .overlay {
                    if model.overview.agents.isEmpty {
                        ContentUnavailableView(
                            "No agents",
                            systemImage: "terminal",
                            description: Text("Start one on one of your computers with +."))
                    }
                }
            }
            .navigationTitle("Agents")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { starting = true } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("Start an agent")
                    .disabled(model.overview.devices.isEmpty)
                }
            }
            .navigationDestination(for: AgentRef.self) { ref in
                AgentScreen(model: model, ref: ref)
            }
            .sheet(isPresented: $starting) {
                StartView(model: model) { ref in
                    starting = false
                    path.append(ref)
                }
            }
        }
    }
}

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
