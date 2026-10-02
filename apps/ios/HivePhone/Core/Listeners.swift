import Foundation

/// The overview's listener (design §5.1): the core says a newer snapshot exists, on a thread of its
/// own; the main thread takes the newest once.
final class OverviewRelay: OverviewListener, @unchecked Sendable {
    private let relay: MainRelay

    init(pull: @escaping @MainActor () -> Void) {
        relay = MainRelay(pull: pull)
    }

    func changed(revision: UInt64) {
        relay.poke()
    }
}

/// A terminal's listener (design §5.3). Frames coalesce as the overview's do; who holds the keyboard
/// and the end are rare, and each hops on its own with what it says.
final class ScreenRelay: ScreenListener, @unchecked Sendable {
    private let frames: MainRelay
    private let onKeyboard: @MainActor (String?) -> Void
    private let onEnded: @MainActor (ScreenEnded) -> Void

    init(
        frame: @escaping @MainActor () -> Void,
        keyboard: @escaping @MainActor (String?) -> Void,
        ended: @escaping @MainActor (ScreenEnded) -> Void
    ) {
        frames = MainRelay(pull: frame)
        onKeyboard = keyboard
        onEnded = ended
    }

    func frameReady(revision: UInt64) {
        frames.poke()
    }

    func keyboard(holder: String?) {
        let onKeyboard = self.onKeyboard
        DispatchQueue.main.async {
            MainActor.assumeIsolated { onKeyboard(holder) }
        }
    }

    func ended(why: ScreenEnded) {
        let onEnded = self.onEnded
        DispatchQueue.main.async {
            MainActor.assumeIsolated { onEnded(why) }
        }
    }
}

/// A conversation's listener (design §5.4). Unlike a frame, each telling says something new, so
/// none is dropped: what it is told is kept in order until the main thread takes all of it, with at
/// most one hop in flight however many tellings came meanwhile.
final class ConversationRelay: ConversationListener, @unchecked Sendable {
    enum Told: Equatable {
        case said([Entry], anew: Bool)
        case ended(ConversationEnded)
    }

    private let inbox: Inbox<Told>
    private let hop: MainRelay

    init(take: @escaping @MainActor ([Told]) -> Void) {
        let inbox = Inbox<Told>()
        self.inbox = inbox
        hop = MainRelay { take(inbox.drain()) }
    }

    func said(entries: [Entry], anew: Bool) {
        inbox.put(.said(entries, anew: anew))
        hop.poke()
    }

    func ended(why: ConversationEnded) {
        inbox.put(.ended(why))
        hop.poke()
    }
}

/// A community view's listener (design §5.5): what its host says, each message for the page as it
/// is, and when the view starts again or ends. As with a conversation, none is dropped and the order
/// is kept: the page is handed every message in turn, and a view starts again only after its page
/// of before was handed all that was said to it.
final class ViewRelay: ViewListener, @unchecked Sendable {
    enum Told: Equatable {
        case said(String)
        case ended(ViewEnded)
    }

    private let inbox: Inbox<Told>
    private let hop: MainRelay

    init(take: @escaping @MainActor ([Told]) -> Void) {
        let inbox = Inbox<Told>()
        self.inbox = inbox
        hop = MainRelay { take(inbox.drain()) }
    }

    func said(message: String) {
        inbox.put(.said(message))
        hop.poke()
    }

    func ended(why: ViewEnded) {
        inbox.put(.ended(why))
        hop.poke()
    }
}

/// What a core thread told, kept in order until the main thread takes all of it.
final class Inbox<Item>: @unchecked Sendable {
    private let lock = NSLock()
    private var told: [Item] = []

    func put(_ item: Item) {
        lock.lock()
        told.append(item)
        lock.unlock()
    }

    func drain() -> [Item] {
        lock.lock()
        defer { lock.unlock() }
        let all = told
        told = []
        return all
    }
}
