import Foundation
import Observation
import UIKit

/// One agent's live terminal (design §5.3): the `Watch` on the core's emulator, typing into it, and
/// what the screen around the terminal shows of it. Its frames go to the terminal view, which keeps
/// the lines and draws the ones that changed. While its view is on screen and Fit is on, the session
/// is sized to the columns and rows the view shows at a readable size; it gets its size back when
/// the view goes or Fit is let go (the host's rule: the last to fit or type holds the size). The
/// core keeps the watch across the background and the device's reconnects, so the app never
/// watches again on its own account.
@MainActor
@Observable
final class TerminalSession {
    let agent: AgentRef
    /// Who holds its keyboard; nil while the person's own devices do.
    private(set) var holder: String? = nil
    /// How the watch ended, once it has.
    private(set) var end: ScreenEnded? = nil
    /// Whether the session is sized to the phone while its terminal is on screen: on at first.
    private(set) var fitting = true

    @ObservationIgnored private var watch: Watch? = nil
    /// Which watch the listener's calls are about: one that was stopped may still be heard from.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored weak var view: TerminalView? {
        didSet {
            if view == nil { readable = nil }
            pull()
            refit()
        }
    }
    /// The size the view on screen shows at a readable text size.
    @ObservationIgnored private var readable: TerminalSize? = nil
    /// The size the session was fitted to, while the phone holds one.
    @ObservationIgnored private var fitted: TerminalSize? = nil
    /// Typing was asked for before the view was on screen.
    @ObservationIgnored private var typingAsked = false

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
            ended: { [weak self] why in
                guard let self, self.generation == current else { return }
                self.ended(why)
            })
        watch = phone.watch(agent: agent, listener: relay)
        view?.reset()
        pull()
        refit()
    }

    /// Watched no more: a size the phone fitted goes with the watch.
    func stop() {
        watch?.stop()
        watch = nil
        fitted = nil
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

    /// The phone's keyboard, typing into the terminal: now, or once its view is on screen.
    func beginTyping() {
        if let view, view.window != nil {
            _ = view.becomeFirstResponder()
        } else {
            typingAsked = true
        }
    }

    /// Its view came on screen.
    func viewShown() {
        guard typingAsked else { return }
        typingAsked = false
        Task { _ = self.view?.becomeFirstResponder() }
    }

    /// Fit: on, the session takes the phone's size; off, it gets back the size it had.
    func toggleFitting() {
        fitting.toggle()
        refit()
    }

    /// The view on screen shows `size` at a readable text size, newly or after a change (the
    /// keyboard, a turn).
    func readableSizeChanged(_ size: TerminalSize) {
        readable = size
        refit()
    }

    /// Fitted while Fit is on and its view is on screen; else given back the size it had.
    private func refit() {
        guard let watch else { return }
        if fitting, view != nil, let readable {
            guard readable != fitted else { return }
            fitted = readable
            watch.fit(cols: UInt16(clamping: readable.cols), rows: UInt16(clamping: readable.rows))
        } else if fitted != nil {
            fitted = nil
            watch.unfit()
        }
    }

    /// Told once, last.
    private func ended(_ why: ScreenEnded) {
        end = why
        _ = view?.resignFirstResponder()
        stop()
    }
}
