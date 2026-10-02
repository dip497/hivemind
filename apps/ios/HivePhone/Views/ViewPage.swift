import CoreGraphics
import Foundation
import Observation

/// A community view shown on the phone (design §6.1, P8 step 4): its session on the computer that
/// holds its workspace, relayed both ways with its page in the web view; the screen it is shown on,
/// told as it changes; and, once it ends, why, in place of the page.
///
/// Each page that comes meets a session of its own: the computer's host takes one `ready` from a
/// session. A session the core opened again after a reconnect (`Restarting`) waits for the page
/// loaded anew; any other page (the web content process gone and the page loaded again, a page that
/// loads another, the person coming back to the view) is given a new session. A session takes only
/// what the page it waits for posts, never what the page before it does. Leaving the view stops it.
@MainActor
@Observable
final class ViewPage {
    let offered: OfferedView
    /// Why the view is shown no more, in the app's words, in place of the page.
    private(set) var ended: String? = nil
    /// Why its page could not be had, in place of it until it is loaded again.
    private(set) var unloaded: String? = nil
    /// What the phone's lock said when it could not be asked about what the view would start or
    /// close.
    var notice: String? = nil

    /// The page's web view, once SwiftUI has made it.
    @ObservationIgnored weak var web: ViewPageWeb? {
        didSet {
            if web != nil && waiting { load() }
        }
    }

    @ObservationIgnored private var phone: Phone? = nil
    @ObservationIgnored private var session: ViewSession? = nil
    /// Which session the listener's calls are about: one stopped may still be heard from.
    @ObservationIgnored private var generation = 0
    /// The session waits for its page: the next page to come is its.
    @ObservationIgnored private var fresh = false
    /// How many pages have come: what the lock lets through goes only to the page that asked.
    @ObservationIgnored private var pages = 0
    /// The page is to be loaded once the web view is there.
    @ObservationIgnored private var waiting = false
    /// The screen the view is shown on, as last told.
    @ObservationIgnored private var screen = Screen(width: 0, height: 0, theme: ViewTheme(mode: .light, colors: [:]))

    init(offered: OfferedView) {
        self.offered = offered
    }

    /// The view is shown: a session of its own, and its page.
    func start(on phone: Phone) {
        self.phone = phone
        ended = nil
        notice = nil
        open()
        load()
    }

    /// The view is left: its session stops, and nothing it says reaches the page.
    func stop() {
        session?.stop()
        session = nil
        phone = nil
        generation += 1
        fresh = false
        waiting = false
    }

    /// The web view's size changed: the phone turned, the keyboard came or went.
    func sized(_ size: CGSize) {
        let (width, height) = ViewLook.size(size)
        guard width != screen.width || height != screen.height else { return }
        screen.width = width
        screen.height = height
        session?.screen(screen: screen)
    }

    /// The app's look changed: dark or light, the contrast, the person's colour.
    func looks(_ theme: ViewTheme) {
        guard theme != screen.theme else { return }
        screen.theme = theme
        session?.screen(screen: screen)
    }

    /// What the page posted, for its host: at once, or only once the phone's lock says it is the
    /// person. Nothing from a page before the one the session waits for.
    func posted(_ text: String) {
        guard let session, !fresh else { return }
        switch ViewPost(text, view: offered.info.name, device: offered.deviceName) {
        case .now:
            session.post(message: text)
        case .afterLock(let reason):
            let asking = pages
            Task { [weak self] in
                let outcome = await DeviceLock.ask(reason)
                guard let self, self.pages == asking, !self.fresh, let session = self.session else { return }
                switch outcome {
                case .unlocked:
                    session.post(message: text)
                case .cancelled:
                    break
                case .unavailable(let why):
                    self.notice = why
                }
            }
        }
    }

    /// A page came in the web view: the session waiting for one takes it; else it is given a new
    /// session.
    func committed() {
        pages += 1
        guard phone != nil, ended == nil else { return }
        if !fresh { open() }
        fresh = false
    }

    /// The web content process went, and the page with it: the page loaded again, on a new session.
    func terminated() {
        guard phone != nil, ended == nil else { return }
        open()
        load()
    }

    /// The page itself could not be had from the computer: why, in its place, until it is loaded
    /// again.
    func pageFailed(_ why: String) {
        unloaded = why
    }

    /// A new session, for the next page: the one before stops, and is heard from no more.
    private func open() {
        guard let phone else { return }
        session?.stop()
        generation += 1
        let current = generation
        let relay = ViewRelay { [weak self] told in
            guard let self, self.generation == current else { return }
            self.take(told)
        }
        session = phone.openView(
            device: offered.device, workspace: offered.workspace, view: offered.info.id, screen: screen,
            listener: relay)
        fresh = true
    }

    /// The page, loaded anew once the web view is there.
    private func load() {
        guard let web else {
            waiting = true
            return
        }
        waiting = false
        guard let url = offered.origin.url(of: offered.info.page) else { return }
        unloaded = nil
        web.load(url)
    }

    /// What the session told, in order: what its host said goes to the page as it is; starting
    /// again loads the page anew, for the session the core opened again; any other end is the last.
    private func take(_ told: [ViewRelay.Told]) {
        for telling in told {
            switch telling {
            case .said(let message):
                web?.say(message)
            case .ended(let why):
                switch ViewEnd(why, device: offered.deviceName) {
                case .again:
                    fresh = true
                    load()
                case .over(let words):
                    session?.stop()
                    session = nil
                    generation += 1
                    ended = words
                    return
                }
            }
        }
    }
}

/// What becomes of what a view's page posts (design §4, §6.1): it goes to the view's host at once,
/// unless it starts or closes something on the board (`viewAsksLock`), which goes only once the
/// phone's lock says it is the person, as the app's own Start and Close do.
enum ViewPost: Equatable {
    case now
    /// Once the lock is opened, asked with this reason.
    case afterLock(reason: String)

    init(_ message: String, view: String, device: String) {
        if viewAsksLock(message: message) {
            self = .afterLock(reason: "\(view) asks to start or close something on \(device)")
        } else {
            self = .now
        }
    }
}

/// What a view's session ending does (design §5.5): starting again, the page is loaded anew for the
/// session the core opened again; anything else is the last it is told, and the page is replaced by
/// why, in the app's words (the Android app says the same).
enum ViewEnd: Equatable {
    case again
    case over(String)

    init(_ ended: ViewEnded, device: String) {
        switch ended {
        case .restarting:
            self = .again
        case .disabled(let why):
            self = .over("\(device) turned this view off: \(why)")
        case .refused(let why):
            self = .over("\(device) said no: \(why)")
        case .notHeld:
            self = .over("Its workspace is not on \(device) now.")
        case .unpaired:
            self = .over("\(device) is not one of your devices now.")
        }
    }
}
