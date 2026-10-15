import SwiftUI

/// The home tab (design §6.2): what waits on the person, the longest-waiting first, each a card
/// with the answers its wait allows; a device away, and what it last said.
@MainActor
struct NeedsTab: View {
    let model: PhoneModel
    @State private var path: [AgentRef] = []
    @State private var composing: Composing? = nil

    var body: some View {
        NavigationStack(path: $path) {
            TimelineView(.everyMinute) { context in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(NeedsSummary.away(model.overview.devices), id: \.id) { device in
                            Label(NeedsSummary.awayLine(device, now: context.date), systemImage: "wifi.slash")
                                .font(.footnote)
                                .foregroundStyle(Look.tertiary)
                        }
                        let asking = NeedsSummary.asking(model.overview.devices)
                        ForEach(asking, id: \.id) { device in
                            Label(NeedsSummary.askingLine(device), systemImage: "ellipsis")
                                .font(.footnote)
                                .foregroundStyle(Look.tertiary)
                        }
                        if model.overview.needs.isEmpty,
                           let nothing = NeedsSummary.nothing(working: model.overview.working, asking: asking) {
                            Text(nothing)
                                .font(.subheadline)
                                .foregroundStyle(Look.secondary)
                        }
                        ForEach(model.overview.needs, id: \.at) { agent in
                            NeedRow(model: model, agent: agent, now: context.date) { waiting in
                                composing = Composing(agent: agent, waiting: waiting)
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                }
                .background(Look.background)
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

/// One wait (design §6.2), as a raised card: what it asks and for how long, the agent with its
/// workspace and machine, which open the agent; and the answers that fit on the card.
@MainActor
struct NeedRow: View {
    let model: PhoneModel
    let agent: Agent
    let now: Date
    let compose: (Waiting) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            NavigationLink(value: agent.at) {
                VStack(alignment: .leading, spacing: 10) {
                    if let waiting = agent.waiting {
                        HStack(spacing: 8) {
                            Dot(color: Look.waiting)
                            Text(NeedsSummary.asked(waiting.kind))
                                .font(.footnote.weight(.medium))
                                .foregroundStyle(Look.secondary)
                            Spacer(minLength: 8)
                            Text(Ago.span(since: waiting.since, now: now))
                                .monospacedDigit()
                                .font(.footnote)
                                .foregroundStyle(Look.tertiary)
                        }
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text(agent.name)
                            .font(.headline)
                            .tracking(-0.34)
                            .foregroundStyle(Look.text)
                            .lineLimit(1)
                        Text("\(agent.workspaceName) · \(agent.machine)")
                            .font(.footnote)
                            .foregroundStyle(Look.tertiary)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if let waiting = agent.waiting {
                AnswerButtons(model: model, agent: agent, waiting: waiting) { compose(waiting) }
            }
        }
        .padding(16)
        .raisedCard()
    }
}

/// The answers a wait allows (design §6.2), as full-width pills, the first filled: Allow over Deny
/// at once; a plan or a question opens to its sheet.
@MainActor
struct AnswerButtons: View {
    let model: PhoneModel
    let agent: Agent
    let waiting: Waiting
    let compose: () -> Void

    var body: some View {
        switch Answers(waiting) {
        case .decide:
            VStack(spacing: 8) {
                Button("Allow") { model.answer(agent, waiting, with: .decide(decision: .allow)) }
                    .buttonStyle(.filledPill)
                Button("Deny", role: .destructive) { model.answer(agent, waiting, with: .decide(decision: .deny)) }
                    .buttonStyle(.outlinedPill)
            }
        case .plan:
            Button("Review the plan", action: compose)
                .buttonStyle(.outlinedPill)
        case .reply:
            Button("Reply", action: compose)
                .buttonStyle(.outlinedPill)
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
