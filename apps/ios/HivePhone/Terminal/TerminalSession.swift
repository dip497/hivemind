import Foundation
import Observation
import UIKit

/// One agent's live terminal (design §5.3): the `Watch` on the core's emulator, typing into it, and
/// what the screen around the terminal shows of it. Its frames go to the terminal view, which keeps
/// the lines and draws the ones that changed. The core keeps the watch across the background and
/// the device's reconnects, so the app never watches again on its own account.
@MainActor
@Observable
final class TerminalSession {
    enum End: Equatable {
        /// The session ended, with its code.
        case session(Int64)
        /// There is no terminal to watch: it ended unseen, its workspace is not on that device now,
        /// or the device refused it.
        case nothing
    }

    let agent: AgentRef
    /// Who holds its keyboard; nil while the person's own devices do.
    private(set) var holder: String? = nil
    private(set) var end: End? = nil

    @ObservationIgnored private var watch: Watch? = nil
    /// Which watch the listener's calls are about: one that was stopped may still be heard from.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored weak var view: TerminalView? {
        didSet { pull() }
    }

    init(agent: AgentRef) {
        self.agent = agent
    }

    /// Watches the terminal, from a new numbering of its lines.
    func start(on phone: Phone) {
        stop()
        end = nil
        holder = nil
        generation += 1
        let current = generation
        let relay = ScreenRelay(
            frame: { [weak self] in self?.pull() },
            keyboard: { [weak self] holder in
                guard let self, self.generation == current else { return }
                self.holder = holder
            },
            ended: { [weak self] code in
                guard let self, self.generation == current else { return }
                self.ended(code)
            })
        watch = phone.watch(agent: agent, listener: relay)
        view?.reset()
        pull()
    }

    func stop() {
        watch?.stop()
        watch = nil
    }

    /// The one pull per frame (§3.4, §3.5): every line changed since the revision the view last
    /// drew, in one call.
    func pull() {
        guard let watch, let view else { return }
        view.apply(watch.update(since: view.revision))
    }

    /// Typed as it is, as the person.
    func type(_ text: String) {
        watch?.typeText(text: text)
    }

    /// Keys as `hive ctl keys` names them: enter, escape, tab, up, backspace, ctrl-c, …
    func press(_ keys: [String]) {
        watch?.typeKeys(keys: keys)
    }

    /// The phone's keyboard, typing into the terminal.
    func beginTyping() {
        _ = view?.becomeFirstResponder()
    }

    /// Told once, last.
    private func ended(_ code: Int64?) {
        if let code {
            end = .session(code)
        } else {
            end = .nothing
        }
        _ = view?.resignFirstResponder()
        stop()
    }
}
