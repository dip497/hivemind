import SwiftUI

/// One agent (design §6.4, P7): what it and the person said, as a chat, or its live terminal,
/// fitted to the width and following the newest line; what it waits on, as a card with its
/// answers; a composer whose send stops the agent's turn while nothing is typed, and Type, which
/// types into its terminal as the person; its changes, and Close under More. The chat and the
/// terminal are both followed while the screen is up, so switching between them waits on nothing.
@MainActor
struct AgentScreen: View {
    enum Showing {
        case chat
        case terminal

        /// What may be shown of `agent`, as offered: the chat only when it keeps a conversation
        /// its device can read (its manifest maps its session file), and its terminal.
        static func offered(for agent: Agent?) -> [Showing] {
            agent?.hasConversation == true ? [.chat, .terminal] : [.terminal]
        }
    }

    let model: PhoneModel
    let ref: AgentRef
    @State private var session: TerminalSession
    @State private var chat: ChatSession
    @State private var showing = Showing.chat
    @State private var reply = ""
    @State private var composing: Composing? = nil
    @State private var showingDiff = false
    @Environment(\.dismiss) private var dismiss

    init(model: PhoneModel, ref: AgentRef) {
        self.model = model
        self.ref = ref
        _session = State(initialValue: TerminalSession(agent: ref))
        _chat = State(initialValue: ChatSession(agent: ref))
    }

    /// The agent as the newest overview has it; nil a moment after it was started, or once closed.
    private var agent: Agent? {
        model.overview.agents.first { $0.at == ref }
    }

    /// What is shown: as the person chose, when this agent offers it; else its terminal.
    private var shown: Showing {
        Showing.offered(for: agent).contains(showing) ? showing : .terminal
    }

    var body: some View {
        VStack(spacing: 0) {
            if let agent, let waiting = agent.waiting {
                WaitCard(model: model, agent: agent, waiting: waiting) {
                    composing = Composing(agent: agent, waiting: waiting)
                } type: {
                    typeIntoTerminal()
                }
            }
            if Showing.offered(for: agent).count > 1 {
                Picker("Show", selection: $showing) {
                    Text("Chat").tag(Showing.chat)
                    Text("Terminal").tag(Showing.terminal)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.vertical, 4)
            }
            if shown == .terminal, let note {
                Text(note)
                    .font(.footnote)
                    .foregroundStyle(Look.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .background(Look.raised)
            }
            ZStack {
                ChatScreen(session: chat, shown: shown == .chat)
                    .accessibilityHidden(shown != .chat)
                TerminalScreen(session: session, shown: shown == .terminal)
                    .accessibilityHidden(shown != .terminal)
            }
            composer
        }
        .background(Look.background)
        .navigationTitle(agent?.name ?? "Agent")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                title
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    showingDiff = true
                } label: {
                    Image(systemName: "plus.forwardslash.minus")
                }
                .accessibilityLabel("What it changed")
                Menu {
                    Button(role: .destructive) {
                        Task {
                            if await model.close(ref, named: agent?.name ?? "this agent") { dismiss() }
                        }
                    } label: {
                        Label("Close", systemImage: "xmark.circle")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("More")
            }
        }
        .navigationDestination(isPresented: $showingDiff) {
            DiffScreen(model: model, agent: ref)
        }
        .sheet(item: $composing) { item in
            AnswerSheet(model: model, agent: item.agent, waiting: item.waiting)
        }
        .onAppear {
            session.start(on: model.phone)
            chat.start(on: model.phone)
        }
        .onDisappear {
            session.stop()
            chat.stop()
        }
    }

    /// Its name, and under it its state, workspace and machine.
    private var title: some View {
        VStack(spacing: 1) {
            Text(agent?.name ?? "Agent")
                .font(.headline)
                .tracking(-0.34)
                .foregroundStyle(Look.text)
                .lineLimit(1)
            if let agent {
                Text("\(AgentLook.word(agent.state)) · \(agent.workspaceName) · \(agent.machine)")
                    .font(.caption)
                    .foregroundStyle(Look.tertiary)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }

    /// What stands between the person and the terminal, if anything.
    private var note: String? {
        let device = agent?.deviceName ?? "its device"
        switch session.end {
        case .exited(let code)?:
            return code == 0 ? "Its session ended." : "Its session ended (code \(code))."
        case .noSession?:
            return "There is no terminal to watch: its session ended before it was watched."
        case .refused(let why)?:
            return "\(device) said no: \(why)"
        case .notHeld?:
            return "Its workspace is not on \(device) now."
        case .unpaired?:
            return "\(device) is not one of your devices now."
        case nil:
            break
        }
        if let holder = session.holder {
            return "\(holder) holds its keyboard."
        }
        return nil
    }

    /// Type goes to the terminal: shown first, then the keyboard, once SwiftUI has shown it.
    private func typeIntoTerminal() {
        showing = .terminal
        Task { session.beginTyping() }
    }

    /// A raised card pinned under the conversation: Type on the left, the message, and a round send
    /// on the right, which stops the agent's turn while nothing is typed and it can be stopped.
    private var composer: some View {
        HStack(spacing: 8) {
            Button {
                typeIntoTerminal()
            } label: {
                Image(systemName: "keyboard")
                    .foregroundStyle(Look.secondary)
                    .frame(width: 36, height: 36)
            }
            .accessibilityLabel("Type into its terminal")
            .disabled(session.holder != nil || session.end != nil)
            TextField("Message \(agent?.name ?? "it")", text: $reply)
                .textFieldStyle(.plain)
                .foregroundStyle(Look.text)
                .submitLabel(.send)
                .onSubmit(send)
                .accessibilityIdentifier("agent.reply")
            if reply.isEmpty, let agent, AgentLook.offersStop(agent) {
                Button {
                    model.act { _ = try await model.phone.interrupt(agent: ref) }
                } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Look.onPrimary)
                        .frame(width: 34, height: 34)
                        .background(Look.text, in: Circle())
                }
                .accessibilityLabel("Stop")
            } else {
                let empty = reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                Button(action: send) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Look.onPrimary)
                        .frame(width: 34, height: 34)
                        .background(Look.text.opacity(empty ? 0.25 : 1), in: Circle())
                }
                .accessibilityLabel("Send")
                .accessibilityIdentifier("agent.send")
                .disabled(empty)
            }
        }
        .padding(.leading, 6)
        .padding(.trailing, 8)
        .padding(.vertical, 6)
        .raisedCard(floating: true)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    /// A message to the agent (`send`), as the person; kept in the box if it does not go.
    private func send() {
        let text = reply.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        reply = ""
        model.act {
            let went: Bool
            do {
                went = try await model.phone.send(agent: ref, text: text)
            } catch {
                if reply.isEmpty { reply = text }
                throw error
            }
            if !went {
                if reply.isEmpty { reply = text }
                model.notice = "No agent runs there now."
            }
        }
    }
}

/// What the agent waits on, as a card over the conversation, with the answers it allows; what the
/// phone cannot answer in a tap is answered in its terminal.
@MainActor
struct WaitCard: View {
    let model: PhoneModel
    let agent: Agent
    let waiting: Waiting
    let compose: () -> Void
    let type: () -> Void

    var body: some View {
        TimelineView(.everyMinute) { context in
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    Dot(color: Look.waiting)
                    Text("\(NeedsSummary.asked(waiting.kind)) · \(Ago.span(since: waiting.since, now: context.date))")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Look.secondary)
                }
                if Answers(waiting) == .terminal {
                    Button("Answer in its terminal", action: type)
                        .buttonStyle(.outlinedPill)
                } else {
                    AnswerButtons(model: model, agent: agent, waiting: waiting, compose: compose)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .raisedCard()
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
    }
}
