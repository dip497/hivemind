import SwiftUI

/// One agent (design §6.4): its live terminal, fitted to the width and following the newest line;
/// what it waits on, as a banner with its answers; a reply box, and Type, which types into its
/// terminal as the person; Stop, its changes, and Close.
@MainActor
struct AgentScreen: View {
    let model: PhoneModel
    let ref: AgentRef
    @State private var session: TerminalSession
    @State private var reply = ""
    @State private var composing: Composing? = nil
    @State private var showingDiff = false
    @Environment(\.dismiss) private var dismiss

    init(model: PhoneModel, ref: AgentRef) {
        self.model = model
        self.ref = ref
        _session = State(initialValue: TerminalSession(agent: ref))
    }

    /// The agent as the newest overview has it; nil a moment after it was started, or once closed.
    private var agent: Agent? {
        model.overview.agents.first { $0.at == ref }
    }

    private var reachable: Bool {
        model.overview.devices.first { $0.id == ref.device }?.reachable ?? false
    }

    var body: some View {
        VStack(spacing: 0) {
            if let agent, let waiting = agent.waiting {
                WaitBanner(model: model, agent: agent, waiting: waiting) {
                    composing = Composing(agent: agent, waiting: waiting)
                } type: {
                    session.beginTyping()
                }
            }
            if let note {
                Text(note)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                    .background(.bar)
            }
            TerminalScreen(session: session)
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
        .onAppear { session.start(on: model.phone) }
        .onDisappear { session.stop() }
        .onChange(of: reachable) { _, reachable in
            // The connection came back: watch again, from the whole screen.
            if reachable, session.end == .connection { session.start(on: model.phone) }
        }
    }

    /// What stands between the person and the terminal, if anything.
    private var note: String? {
        switch session.end {
        case .session(let code)?:
            return code == 0 ? "Its session ended." : "Its session ended (code \(code))."
        case .connection?:
            return "The connection to \(agent?.deviceName ?? "its device") went; it is watched again when it is back."
        case nil:
            break
        }
        if let holder = session.holder {
            return "\(holder) holds its keyboard."
        }
        return nil
    }

    private var replyBar: some View {
        HStack(spacing: 10) {
            Button {
                session.beginTyping()
            } label: {
                Image(systemName: "keyboard")
            }
            .accessibilityLabel("Type into its terminal")
            .disabled(session.holder != nil || session.end != nil)
            TextField("Message \(agent?.name ?? "it")", text: $reply)
                .textFieldStyle(.roundedBorder)
                .submitLabel(.send)
                .onSubmit(send)
            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
            }
            .accessibilityLabel("Send")
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
            do {
                _ = try await model.phone.send(agent: ref, text: text)
            } catch {
                if reply.isEmpty { reply = text }
                throw error
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
