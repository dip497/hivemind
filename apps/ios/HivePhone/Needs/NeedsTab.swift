import SwiftUI

/// The home tab (design §6.2): what waits on the person, the longest-waiting first, with the
/// answers each wait allows on its row; a device away, and what it last said.
@MainActor
struct NeedsTab: View {
    let model: PhoneModel
    @State private var path: [AgentRef] = []
    @State private var composing: Composing? = nil

    var body: some View {
        NavigationStack(path: $path) {
            TimelineView(.everyMinute) { context in
                List {
                    ForEach(NeedsSummary.away(model.overview.devices), id: \.id) { device in
                        Label(NeedsSummary.awayLine(device, now: context.date), systemImage: "wifi.slash")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    if model.overview.needs.isEmpty {
                        Text(NeedsSummary.nothing(working: model.overview.working))
                            .foregroundStyle(.secondary)
                    }
                    ForEach(model.overview.needs, id: \.at) { agent in
                        NavigationLink(value: agent.at) {
                            NeedRow(model: model, agent: agent, now: context.date) { waiting in
                                composing = Composing(agent: agent, waiting: waiting)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Needs you")
            .navigationDestination(for: AgentRef.self) { ref in
                AgentScreen(model: model, ref: ref)
            }
            .sheet(item: $composing) { item in
                AnswerSheet(model: model, agent: item.agent, waiting: item.waiting)
            }
        }
    }
}

/// An agent's wait, answered in a sheet: a plan to review, a question to reply to.
struct Composing: Identifiable {
    let agent: Agent
    let waiting: Waiting
    var id: AgentRef { agent.at }
}

/// One wait (design §6.2): the agent, its workspace and machine, why it waits and for how long, and
/// the answers that fit on its row.
@MainActor
struct NeedRow: View {
    let model: PhoneModel
    let agent: Agent
    let now: Date
    let compose: (Waiting) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(agent.name)
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if let waiting = agent.waiting {
                    Text(Ago.span(since: waiting.since, now: now))
                        .monospacedDigit()
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Text("\(agent.workspaceName) · \(agent.machine)")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            if let waiting = agent.waiting {
                Text(NeedsSummary.why(waiting.kind))
                    .font(.subheadline)
                AnswerButtons(model: model, agent: agent, waiting: waiting) { compose(waiting) }
            }
        }
        .padding(.vertical, 4)
    }
}

/// The answers a wait allows, as buttons (design §6.2): Allow and Deny at once; a plan or a question
/// opens to its sheet.
@MainActor
struct AnswerButtons: View {
    let model: PhoneModel
    let agent: Agent
    let waiting: Waiting
    let compose: () -> Void

    var body: some View {
        switch Answers(waiting) {
        case .decide:
            HStack(spacing: 12) {
                Button("Allow") { model.answer(agent, waiting, with: .decide(decision: .allow)) }
                    .buttonStyle(.borderedProminent)
                Button("Deny", role: .destructive) { model.answer(agent, waiting, with: .decide(decision: .deny)) }
                    .buttonStyle(.bordered)
            }
        case .plan:
            Button("Review the plan", action: compose)
                .buttonStyle(.bordered)
        case .reply:
            Button("Reply", action: compose)
                .buttonStyle(.bordered)
        case .terminal:
            EmptyView()
        }
    }
}

/// A plan to approve or send back, or a question to reply to: one answer, then the sheet goes.
@MainActor
struct AnswerSheet: View {
    let model: PhoneModel
    let agent: Agent
    let waiting: Waiting
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""

    private var isPlan: Bool {
        if case .plan = waiting.kind { return true }
        return false
    }

    var body: some View {
        NavigationStack {
            Form {
                if isPlan {
                    Section("The plan") {
                        Text(waiting.plan ?? "")
                            .font(.callout)
                            .textSelection(.enabled)
                    }
                    Section {
                        Button("Approve") { send(.plan(approve: true, feedback: nil)) }
                    }
                    Section("Or ask for changes") {
                        TextField("What to change", text: $text, axis: .vertical)
                            .lineLimit(2...8)
                        Button("Ask for changes") { send(.plan(approve: false, feedback: trimmed)) }
                            .disabled(trimmed.isEmpty)
                    }
                } else {
                    Section("Your answer") {
                        TextField("Reply", text: $text)
                            .submitLabel(.send)
                            .onSubmit { if !trimmed.isEmpty { send(.text(text: trimmed)) } }
                        Button("Send") { send(.text(text: trimmed)) }
                            .disabled(trimmed.isEmpty)
                    }
                }
            }
            .navigationTitle(agent.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private var trimmed: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func send(_ answer: Answer) {
        model.answer(agent, waiting, with: answer)
        dismiss()
    }
}
