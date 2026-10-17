import Foundation

/// Hops "something changed" from a core thread to the main thread with at most one hop in flight:
/// however many changes land before the main thread runs, it pulls once (design §3.4). The flag is
/// cleared before the pull, so a change that lands during the pull is pulled again.
final class MainRelay: @unchecked Sendable {
    private let lock = NSLock()
    private var scheduled = false
    private let pull: @MainActor () -> Void

    init(pull: @escaping @MainActor () -> Void) {
        self.pull = pull
    }

    /// Any thread.
    func poke() {
        lock.lock()
        let schedule = !scheduled
        scheduled = true
        lock.unlock()
        guard schedule else { return }
        DispatchQueue.main.async { [self] in
            lock.lock()
            scheduled = false
            lock.unlock()
            MainActor.assumeIsolated { pull() }
        }
    }
}
