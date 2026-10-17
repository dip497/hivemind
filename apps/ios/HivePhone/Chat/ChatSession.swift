import Foundation

/// One agent's conversation (design §5.4, P7): the `Conversation` followed, and the chat's log of
/// it. What the core tells goes into the log, and what that changed to the chat view, which draws
/// the rows. The core follows it across the background and the device's reconnects, from as far as
/// it told, so the app never follows it again on its own account.
@MainActor
final class ChatSession {
    let agent: AgentRef
    private(set) var log = ChatLog()
    weak var view: ChatView? {
        didSet { view?.reload() }
    }
    private var conversation: Conversation? = nil
    /// Which conversation the listener's calls are about: one stopped may still be heard from.
    private var generation = 0

    init(agent: AgentRef) {
        self.agent = agent
    }

    /// Follows the conversation from the last of it the device sends. Its first telling is anew,
    /// so what the chat showed stays until it is replaced, with nothing blank between.
    func start(on phone: Phone) {
        stop()
        generation += 1
        let current = generation
        let relay = ConversationRelay { [weak self] told in
            guard let self, self.generation == current else { return }
            self.take(told)
        }
        conversation = phone.conversation(agent: agent, listener: relay)
    }

    func stop() {
        conversation?.stop()
        conversation = nil
    }

    private func take(_ told: [ConversationRelay.Told]) {
        for telling in told {
            switch telling {
            case .said(let entries, let anew):
                let change = log.take(entries, anew: anew)
                view?.apply(change)
            case .ended(let why):
                if log.end(why) { view?.noteAdded() }
            }
        }
    }
}
