import SwiftUI

/// One agent (design §6.4, P7): what it and the person said, as a chat, newest at the bottom, with
/// what it waits on as its last row; a tool's row opens the use on its own screen. Its terminal opens
/// from an icon in the header over the whole screen, sized to the phone while Fit is on, with what
/// it waits on above it; back returns to the chat. An agent with no chat to read opens on its
/// terminal. A composer whose send stops the agent's turn while nothing is typed, and Type, which
/// types into its terminal as the person; its changes, and Close under More. The chat and the
/// terminal are both followed while the screen is up, so opening the terminal waits on nothing.
@MainActor
struct AgentScreen: View {
    enum Showing {
        case chat
        case terminal

        /// What the screen opens on: the chat when `agent` keeps a conversation its device can read
        /// (its manifest maps its session file), else its terminal.
        static func first(for agent: Agent?) -> Showing {
            agent?.hasConversation == true ? .chat : .terminal
        }
    }

    let model: PhoneModel
    let ref: AgentRef
    @State private var session: TerminalSession
    @State private var chat: ChatSession
    @State private var terminalOpen = false
    @State private var reply = ""
    @State private var composing: Composing? = nil
    @State private var showingDiff = false
    @State private var openedTool: ToolUse? = nil
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

    private var hasChat: Bool {
        Showing.first(for: agent) == .chat
    }

    /// The terminal is on screen: opened from the header, or the agent has no chat.
    private var terminalShown: Bool {
        terminalOpen || !hasChat
    }

    var body: some View {
        VStack(spacing: 0) {
            if terminalShown {
                if let agent, let waiting = agent.waiting {
                    waitCard(agent, waiting)
                }
                if let note {
                    Text(note)
                        .font(.footnote)
                        .foregroundStyle(Look.secondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .background(Look.raised)
                }
            }
            ZStack {
                if hasChat {
                    ChatScreen(session: chat, shown: !terminalShown, wait: chatWait) { use in
                        openedTool = use
                    }
                    .accessibilityHidden(terminalShown)
                }
                if terminalShown {
                    TerminalScreen(session: session)
                }
            }
            composer
        }
        .background(Look.background)
        .navigationTitle(agent?.name ?? "Agent")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(terminalOpen)
        .toolbar {
            if terminalOpen {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        terminalOpen = false
                    } label: {
                        Image(systemName: "chevron.backward")
                            .fontWeight(.semibold)
                    }
                    .accessibilityLabel("Back to its chat")
                    .accessibilityIdentifier("terminal.close")
                }
            }
            ToolbarItem(placement: .principal) {
                title
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                if terminalShown {
                    fitButton
                }
                if !terminalOpen {
                    if hasChat {
                        Button {
                            terminalOpen = true
                        } label: {
                            Image(systemName: "terminal")
                        }
                        .accessibilityLabel("Its terminal")
                        .accessibilityIdentifier("agent.terminal.open")
                    }
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
        }
        .navigationDestination(isPresented: $showingDiff) {
            DiffScreen(model: model, agent: ref)
        }
        .navigationDestination(item: $openedTool) { use in
            ToolScreen(use: use)
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

    /// Fit: on, the terminal is sized to the phone; off, it keeps the size it had.
    private var fitButton: some View {
        Button {
            session.toggleFitting()
        } label: {
            Text("Fit")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(session.fitting ? Look.text : Look.secondary)
                .padding(.horizontal, 12)
                .frame(height: 30)
                .background(session.fitting ? Look.selected : Look.background, in: Capsule())
                .overlay { Capsule().strokeBorder(session.fitting ? Look.selected : Look.hairline, lineWidth: 1) }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Fit to the phone")
        .accessibilityAddTraits(session.fitting ? .isSelected : [])
        .accessibilityIdentifier("terminal.fit")
    }

    /// What the agent waits on, as the chat's last row.
    private var chatWait: ChatWait? {
        guard let agent, let waiting = agent.waiting else { return nil }
        return ChatWait(waiting: waiting, card: AnyView(waitCard(agent, waiting, inset: 0)))
    }

    private func waitCard(_ agent: Agent, _ waiting: Waiting, inset: CGFloat = 12) -> some View {
        WaitCard(model: model, agent: agent, waiting: waiting, inset: inset) {
            composing = Composing(agent: agent, waiting: waiting)
        } type: {
            typeIntoTerminal()
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

    /// Type goes to the terminal: shown first, then the keyboard, once it is on screen.
    private func typeIntoTerminal() {
        if hasChat { terminalOpen = true }
        session.beginTyping()
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

/// What the agent waits on, as a card with the answers it allows: the chat's last row, or above the
/// terminal; what the phone cannot answer in a tap is answered in its terminal.
@MainActor
struct WaitCard: View {
    let model: PhoneModel
    let agent: Agent
    let waiting: Waiting
    /// The room either side of the card.
    var inset: CGFloat = 12
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
                WaitAsked(waiting: waiting)
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
            .padding(.horizontal, inset)
            .padding(.vertical, inset == 0 ? 0 : 6)
        }
    }
}
