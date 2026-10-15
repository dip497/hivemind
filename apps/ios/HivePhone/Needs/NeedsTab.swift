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
                WaitAsked(waiting: waiting)
                AnswerButtons(model: model, agent: agent, waiting: waiting) { compose(waiting) }
            }
        }
        .padding(16)
        .raisedCard()
    }
}

/// What a wait asks (design §6.2): the tool a permission is for and its command in mono, four lines
/// of it until tapped; a question's questions and their options, when they are not chosen here.
@MainActor
struct WaitAsked: View {
    let waiting: Waiting
    @State private var whole = false

    var body: some View {
        if let tool = waiting.tool {
            VStack(alignment: .leading, spacing: 6) {
                Label(tool.name, systemImage: "terminal")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Look.secondary)
                if let about = tool.about {
                    Text(about)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(Look.text)
                        .lineLimit(whole ? nil : 4)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Look.background, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .contentShape(Rectangle())
            .onTapGesture { whole.toggle() }
            .accessibilityIdentifier("wait.tool")
        }
        switch Answers(waiting) {
        case .choose, .questions:
            EmptyView()
        default:
            ForEach(waiting.questions.indices, id: \.self) { i in
                let question = waiting.questions[i]
                VStack(alignment: .leading, spacing: 4) {
                    Text(question.question)
                        .font(.callout)
                        .foregroundStyle(Look.text)
                    ForEach(question.options.indices, id: \.self) { n in
                        Text("· \(question.options[n].label)")
                            .font(.footnote)
                            .foregroundStyle(Look.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

/// An option's label, and what it means under it when the agent says.
@MainActor
struct ChoiceLabel: View {
    let option: Choice

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(option.label)
                .font(.subheadline.weight(.medium))
            if let description = option.description {
                Text(description)
                    .font(.footnote)
                    .opacity(0.7)
            }
        }
    }
}

/// The answers a wait allows (design §6.2): Deny and Allow side by side, Allow filled, at once; an
/// option of a question's one question, its options as pills that wrap, at once; several questions
/// each answered, then sent together; a plan, a question or a line of one's own opens to its sheet.
@MainActor
struct AnswerButtons: View {
    let model: PhoneModel
    let agent: Agent
    let waiting: Waiting
    let compose: () -> Void

    var body: some View {
        switch Answers(waiting) {
        case .decide:
            HStack(spacing: 8) {
                Button("Deny", role: .destructive) { model.answer(agent, waiting, with: .decide(decision: .deny)) }
                    .buttonStyle(.outlinedPill)
                Button("Allow") { model.answer(agent, waiting, with: .decide(decision: .allow)) }
                    .buttonStyle(.filledPill)
            }
        case .plan:
            Button("Review the plan", action: compose)
                .buttonStyle(.outlinedPill)
        case .choose:
            let question = waiting.questions[0]
            VStack(alignment: .leading, spacing: 8) {
                Text(question.question)
                    .font(.callout)
                    .foregroundStyle(Look.text)
                WrappingRow {
                    ForEach(question.options.indices, id: \.self) { n in
                        Button {
                            model.answer(agent, waiting, with: .questions(answers: [.chosen(options: [UInt32(n)])]))
                        } label: {
                            ChoiceLabel(option: question.options[n])
                        }
                        .buttonStyle(.choicePill(chosen: false))
                        .accessibilityIdentifier("answer.choice.0.\(n)")
                    }
                }
                Button("Type your own answer", action: compose)
                    .buttonStyle(.outlinedPill)
            }
        case .questions:
            QuestionsForm(questions: waiting.questions) { answers in
                model.answer(agent, waiting, with: .questions(answers: answers))
            }
            .id(waiting.since)
        case .reply:
            Button("Reply", action: compose)
                .buttonStyle(.outlinedPill)
        case .terminal:
            EmptyView()
        }
    }
}

/// Several questions, or one of several answers: each its options and a line of its own, the one or
/// the other; one Send once each has an answer, each answer in its question's place.
@MainActor
struct QuestionsForm: View {
    let send: ([QuestionAnswer]) -> Void
    @State private var picks: QuestionPicks

    init(questions: [Question], send: @escaping ([QuestionAnswer]) -> Void) {
        self.send = send
        _picks = State(initialValue: QuestionPicks(questions))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(picks.questions.indices, id: \.self) { i in
                let question = picks.questions[i]
                VStack(alignment: .leading, spacing: 8) {
                    Text(question.question)
                        .font(.callout)
                        .foregroundStyle(Look.text)
                    if question.many {
                        Text("Choose any")
                            .font(.footnote)
                            .foregroundStyle(Look.tertiary)
                    }
                    WrappingRow {
                        ForEach(question.options.indices, id: \.self) { n in
                            let chosen = picks.isChosen(n, of: i)
                            Button {
                                picks.pick(n, of: i)
                            } label: {
                                ChoiceLabel(option: question.options[n])
                            }
                            .buttonStyle(.choicePill(chosen: chosen))
                            .accessibilityAddTraits(chosen ? .isSelected : [])
                            .accessibilityIdentifier("answer.choice.\(i).\(n)")
                        }
                    }
                    TextField("Type something", text: $picks.own[i])
                        .font(.subheadline)
                        .submitLabel(.done)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 11)
                        .background(Look.background, in: Capsule())
                        .overlay { Capsule().strokeBorder(Look.outline, lineWidth: 1) }
                        .accessibilityLabel("Your own answer to: \(question.question)")
                        .accessibilityIdentifier("answer.own.\(i)")
                }
            }
            Button("Send") { send(picks.answers) }
                .buttonStyle(.filledPill)
                .disabled(!picks.answered)
                .accessibilityIdentifier("answer.send")
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
