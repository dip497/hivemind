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
    private let onEnded: @MainActor (Int64?) -> Void

    init(
        frame: @escaping @MainActor () -> Void,
        keyboard: @escaping @MainActor (String?) -> Void,
        ended: @escaping @MainActor (Int64?) -> Void
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

    func ended(code: Int64?) {
        let onEnded = self.onEnded
        DispatchQueue.main.async {
            MainActor.assumeIsolated { onEnded(code) }
        }
    }
}
