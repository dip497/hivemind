import SwiftUI

/// One agent (design §6.4, P7): what it and the person said, as a chat, or its live terminal,
/// fitted to the width and following the newest line; what it waits on, as a banner with its
/// answers; a reply box, and Type, which types into its terminal as the person; Stop, its changes,
/// and Close. The chat and the terminal are both followed while the screen is up, so switching
/// between them waits on nothing.
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
                WaitBanner(model: model, agent: agent, waiting: waiting) {
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
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
            if shown == .terminal, let note {
                Text(note)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .background(.bar)
            }
            ZStack {
                ChatScreen(session: chat, shown: shown == .chat)
                    .accessibilityHidden(shown != .chat)
                TerminalScreen(session: session, shown: shown == .terminal)
                    .accessibilityHidden(shown != .terminal)
            }
            replyBar
        }
        .navigationTitle(agent?.name ?? "Agent")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let agent, AgentLook.offersStop(agent) {
                    Button {
                        model.act { _ = try await model.phone.interrupt(agent: ref) }
                    } label: {
                        Image(systemName: "stop.circle")
                    }
                    .accessibilityLabel("Stop")
                }
                Button {
                    showingDiff = true
                } label: {
                    Image(systemName: "plus.forwardslash.minus")
                }
                .accessibilityLabel("What it changed")
                Button(role: .destructive) {
                    Task {
                        if await model.close(ref, named: agent?.name ?? "this agent") { dismiss() }
                    }
                } label: {
                    Image(systemName: "xmark.circle")
                }
                .accessibilityLabel("Close")
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

    private var replyBar: some View {
        HStack(spacing: 10) {
            Button {
                typeIntoTerminal()
            } label: {
                Image(systemName: "keyboard")
            }
            .accessibilityLabel("Type into its terminal")
            .disabled(session.holder != nil || session.end != nil)
            TextField("Message \(agent?.name ?? "it")", text: $reply)
                .textFieldStyle(.roundedBorder)
                .submitLabel(.send)
                .onSubmit(send)
                .accessibilityIdentifier("agent.reply")
            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
            }
            .accessibilityLabel("Send")
            .accessibilityIdentifier("agent.send")
            .disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
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

/// What the agent waits on, with the answers it allows; what the phone cannot answer in a tap is
/// answered in its terminal.
@MainActor
struct WaitBanner: View {
    let model: PhoneModel
    let agent: Agent
    let waiting: Waiting
    let compose: () -> Void
    let type: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(NeedsSummary.why(waiting.kind))
                .font(.subheadline.weight(.semibold))
            if Answers(waiting) == .terminal {
                Button("Answer in its terminal", action: type)
                    .buttonStyle(.bordered)
            } else {
                AnswerButtons(model: model, agent: agent, waiting: waiting, compose: compose)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.12))
    }
}
